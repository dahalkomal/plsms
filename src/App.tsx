import React, { useState, useEffect, useRef } from 'react';
import { auth, db, startGoogleSignIn, startEmailSignIn, logOutFromApp, sendPasswordReset, isQuotaOrMemoryError } from './firebase';
import { onAuthStateChanged, User, updatePassword } from 'firebase/auth';
import { doc, onSnapshot, setDoc, getDoc, collection, getDocs, addDoc, deleteDoc } from 'firebase/firestore';
import { OfficeSettings, AppRole, UserRole, License } from './types';
import { validateStrongPassword } from './utils/passwordValidator';
import { registryDataStore } from './registryDataStore';
import { isDemoModeActive, setDemoModeActive, getOfficeSettings, getSearchesServedCount, getAllUserRoles, subscribeToUserRoles, saveUserRole, seedAllDemoDataToFirestore, DEFAULT_CREDENTIALS_MATRIX, sanitizeOfficeSettings, checkAndTriggerQuotaError, clearQuotaExceededFlag, safeDispatchEvent, verifyUserPassword, hashCredential, clearSessionCache } from './dbService';
import PublicSearch from './components/PublicSearch';
import NoticeBoard from './components/NoticeBoard';
import StaffDashboard from './components/StaffDashboard';
import RequestManager from './components/RequestManager';
import SettingsPanel from './components/SettingsPanel';
import DevSwitcher from './components/DevSwitcher';
import { PageHeader, PageTitleProvider } from './components/PageHeader';
import { Shield, Sparkles, LogIn, LogOut, Search, Volume2, Calendar, Settings, Mail, Phone, HelpCircle, MapPin, LayoutDashboard, Database, Sun, Moon, Eye, EyeOff, Key, AlertCircle, CheckCircle, QrCode, Printer, Download, Copy, X, Users, Lock } from 'lucide-react';
import { convertADToBS } from './utils/dateConverter';

// Formatter helper for Nepali Date & Time
function getFormattedNepaliDateTime(date: Date) {
  const nepaliDays = ['आइतबार', 'सोमबार', 'मङ्गलबार', 'बुधबार', 'बिहीबार', 'शुक्रबार', 'शनिबार'];
  const nepaliMonths = [
    'बैशाख', 'जेठ', 'असार', 'साउन', 'भदौ', 'असोज', 
    'कात्तिक', 'मङ्सिर', 'पुस', 'माघ', 'फागुन', 'चैत'
  ];
  const nepaliDigits = ['०', '१', '२', '३', '४', '५', '६', '७', '८', '९'];
  
  const toNpDigits = (num: number | string): string => {
    return String(num).split('').map(char => {
      const digit = parseInt(char, 10);
      return isNaN(digit) ? char : nepaliDigits[digit];
    }).join('');
  };

  const dayName = nepaliDays[date.getDay()];
  
  let bsDateStr = '२०८३-०३-२९';
  try {
    bsDateStr = convertADToBS(date);
  } catch (e) {
    console.error("BS conversion failed", e);
  }
  
  const [yearStr, monthStr, dayStr] = bsDateStr.split('-');
  const monthVal = parseInt(monthStr, 10) || 1;
  const dayVal = parseInt(dayStr, 10) || 1;
  
  const monthName = nepaliMonths[monthVal - 1] || 'बैशाख';
  const formattedDate = `${dayName} ${toNpDigits(dayVal)} ${monthName} ${toNpDigits(yearStr)}`;
  
  // Format Time
  let hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  
  let ampm = 'बिहान';
  if (hours >= 12) {
    if (hours < 16) ampm = 'दिउँसो';
    else if (hours < 20) ampm = 'साँझ';
    else ampm = 'राती';
  } else {
    if (hours < 4 || hours >= 20) ampm = 'राती';
  }
  
  const displayHours = hours % 12 || 12;
  const formattedTime = `${toNpDigits(String(displayHours).padStart(2, '0'))}:${toNpDigits(minutes)}:${toNpDigits(seconds)} ${ampm}`;
  
  return {
    dateStr: formattedDate,
    timeStr: formattedTime
  };
}

const NepaliClockWidget: React.FC = React.memo(() => {
  const [time, setTime] = useState(() => new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const formatted = getFormattedNepaliDateTime(time);

  return (
    <>
      <div className="text-white text-[10px] xs:text-[11px] sm:text-xs md:text-[13px] font-bold tracking-tight leading-snug shrink-0 mt-0.5">
        {formatted.dateStr}
      </div>
      <div className="text-white text-[9px] xs:text-[10px] sm:text-[11px] md:text-[12px] font-black tracking-widest opacity-90 shrink-0">
        {formatted.timeStr}
      </div>
    </>
  );
});

export default function App() {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [currentRole, setCurrentRole] = useState<AppRole>('public');
  const [authLoading, setAuthLoading] = useState(true);
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [statsLoaded, setStatsLoaded] = useState(false);
  const [demoActive, setDemoActive] = useState(() => {
    localStorage.removeItem('plsms_quota_exceeded');
    localStorage.removeItem('plsms_demo_active');
    return false;
  });
  const [quotaExceeded, setQuotaExceeded] = useState(false);
  const [showQrModal, setShowQrModal] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isPlsmsPath, setIsPlsmsPath] = useState(() => {
    try {
      return window.location.pathname.replace(/\/$/, '') === '/plsms';
    } catch (e) {
      return false;
    }
  });

  useEffect(() => {
    const handlePathChange = () => {
      try {
        setIsPlsmsPath(window.location.pathname.replace(/\/$/, '') === '/plsms');
        const params = new URLSearchParams(window.location.search);
        const tabParam = params.get('tab');
        if (tabParam && ['search', 'notices', 'dashboard', 'reports', 'requests', 'settings'].includes(tabParam)) {
          setActiveTab(tabParam as any);
        } else {
          setActiveTab('search');
        }
      } catch (e) {
        setIsPlsmsPath(false);
      }
    };
    window.addEventListener('popstate', handlePathChange);
    return () => window.removeEventListener('popstate', handlePathChange);
  }, []);

  // Logged-in staff display name and session states
  const [authStaffName, setAuthStaffName] = useState<string>('');
  const [sessionExpiredNotice, setSessionExpiredNotice] = useState<string | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const [showSessionWarning, setShowSessionWarning] = useState(false);
  const [warningSecondsLeft, setWarningSecondsLeft] = useState(30);

  const handleDownloadQr = async () => {
    try {
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=500x500&color=1e3a8a&data=${encodeURIComponent('https://plsms.onrender.com/')}`;
      const response = await fetch(qrUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'PLSMS-QR-Code.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Failed to download QR code", err);
    }
  };

  const handlePrintQr = () => {
    const printWindow = window.open('', '_blank');
    if (printWindow) {
      printWindow.document.write(`
        <html>
          <head>
            <title>Print PLSMS QR Code</title>
            <style>
              body {
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 100vh;
                margin: 0;
                padding: 24px;
                font-family: system-ui, -apple-system, sans-serif;
                color: #1e3a8a;
                box-sizing: border-box;
              }
              .office-title {
                font-size: 18px;
                font-weight: 900;
                text-align: center;
                color: #1e3a8a;
                margin: 0;
                letter-spacing: -0.02em;
                white-space: nowrap;
              }
              .office-address {
                font-size: 13px;
                font-weight: 600;
                text-align: center;
                color: #475569;
                margin: 4px 0 20px 0;
              }
              .container {
                border: 3px dashed #1e3a8a;
                border-radius: 24px;
                padding: 28px;
                background: white;
                display: flex;
                align-items: center;
                justify-content: center;
              }
              img {
                width: 260px;
                height: 260px;
              }
              .plsms-title {
                margin-top: 20px;
                font-size: 13px;
                font-weight: 800;
                text-align: center;
                color: #1e3a8a;
                white-space: nowrap;
              }
              .link {
                margin-top: 14px;
                padding: 8px 20px;
                background: #f0fdf4;
                border: 1px solid #bbf7d0;
                border-radius: 10px;
                font-family: monospace;
                font-size: 13px;
                font-weight: 700;
                color: #166534;
              }
            </style>
          </head>
          <body>
            <h1 class="office-title">Transport Management Office, Driving License</h1>
            <div class="office-address">Itahari, Sunsari</div>
            <div class="container">
              <img src="https://api.qrserver.com/v1/create-qr-code/?size=350x350&color=1e3a8a&data=${encodeURIComponent('https://plsms.onrender.com/')}" />
            </div>
            <div class="plsms-title">Printed License Search Management System (PLSMS)</div>
            <div class="link">https://plsms.onrender.com/</div>
            <script>
              window.onload = function() {
                window.print();
                setTimeout(function() { window.close(); }, 500);
              };
            </script>
          </body>
        </html>
      `);
      printWindow.document.close();
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText('https://plsms.onrender.com/');
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  // Mandatory password change state (Section ASSIGN USER CREDENTIALS & ROLE)
  const [showMustChangeModal, setShowMustChangeModal] = useState(false);
  const [mustChangeUserRecord, setMustChangeUserRecord] = useState<UserRole | null>(null);
  const [tempPasswordInput, setTempPasswordInput] = useState('');
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [newPasswordConfirmInput, setNewPasswordConfirmInput] = useState('');
  const [changePasswordError, setChangePasswordError] = useState<string | null>(null);
  const [changePasswordSuccess, setChangePasswordSuccess] = useState<boolean>(false);
  const [changePasswordLoading, setChangePasswordLoading] = useState(false);

  // Sync theme loading (Default is light mode "shown at first")
  const [userTheme, setUserTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('applet_theme');
    return saved === 'dark' ? 'dark' : 'light';
  });

  const effectiveRole = React.useMemo(() => {
    if (currentUser) {
      const email = (currentUser.email || '').toLowerCase();
      if (email === 'dahalkomal@gmail.com' || email.startsWith('superuser') || email.startsWith('dahalkomal_auto') || email.startsWith('superadmin')) {
        return 'superuser';
      }
      if (email.startsWith('admin') || email.includes('admin') || email.includes('controller')) {
        return 'admin';
      }
      if (email.startsWith('staff') || email.includes('staff') || email.includes('operator')) {
        return 'staff';
      }
      if (currentRole && currentRole !== 'public') {
        return currentRole;
      }
      // Any authenticated user logged into the application defaults to at least 'staff' level access
      return 'staff';
    }
    return 'public';
  }, [currentUser, currentRole]);

  const isStaff = currentUser !== null && (effectiveRole === 'staff' || effectiveRole === 'admin' || effectiveRole === 'superuser');
  const isAdmin = currentUser !== null && (effectiveRole === 'admin' || effectiveRole === 'superuser');

  useEffect(() => {
    if (isPlsmsPath && isStaff && activeTab === 'search') {
      setActiveTab('dashboard');
    }
  }, [isPlsmsPath, isStaff]);

  const theme = isStaff ? userTheme : 'light';

  useEffect(() => {
    const body = document.body;
    body.classList.remove('light', 'dark');
    body.classList.add(theme);
    localStorage.setItem('applet_theme', userTheme);
  }, [theme, userTheme]);

  // Settings state synced in real-time from Firestore (Section 14)
  const [settings, setSettings] = useState<OfficeSettings>({
    officeName: "Transport Management Office, Driving License",
    officeAddress: "Itahari, Sunsari, Nepal",
    officeLogo: "/nepal-emblem.svg",
    contactNumber: "+977-25-580121",
    emailAddress: "tmoitahari@gmail.com",
    websiteFooter: "© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance.",
    homepageBanner: "Welcome to Transport Management Office Driving License Records Center",
    searchMenuLabel: "Search",
    requestMenuLabel: "Schedule Pickup",
    contactMenuLabel: "Contact Desk",
    noticesMenuLabel: "NOTICES",
    consoleSecurityPin: "1234"
  });

  // Footer counter state
  const [searchesServed, setSearchesServed] = useState(0);

  // Navigation tab state
  const [activeTab, setActiveTab] = useState<'search' | 'notices' | 'dashboard' | 'reports' | 'requests' | 'settings'>(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get('tab');
      if (tabParam && ['search', 'notices', 'dashboard', 'reports', 'requests', 'settings'].includes(tabParam)) {
        return tabParam as any;
      }
    } catch (e) {
      console.warn("Failed to read tab parameter", e);
    }
    return 'search';
  });

  // Keep the browser navigation URL in sync with the current active tab
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      if (activeTab === 'search') {
        url.searchParams.delete('tab');
      } else {
        url.searchParams.set('tab', activeTab);
      }
      const newSearch = url.searchParams.toString();
      const newUrl = url.pathname + (newSearch ? `?${newSearch}` : '') + url.hash;
      window.history.replaceState(null, '', newUrl);
    } catch (e) {
      console.warn("Failed to synchronize URL with activeTab", e);
    }
  }, [activeTab]);

  const handleSelectTab = (tab: 'search' | 'notices' | 'dashboard' | 'reports' | 'requests' | 'settings', extraParams?: Record<string, string>) => {
    setActiveTab(tab);
    if (extraParams) {
      try {
        const url = new URL(window.location.href);
        if (tab === 'search') {
          url.searchParams.delete('tab');
        } else {
          url.searchParams.set('tab', tab);
        }
        Object.entries(extraParams).forEach(([k, v]) => {
          url.searchParams.set(k, v);
        });
        const newSearch = url.searchParams.toString();
        const newUrl = url.pathname + (newSearch ? `?${newSearch}` : '') + url.hash;
        window.history.pushState({}, '', newUrl);
      } catch (err) {
        console.warn("Failed to set extra query parameters", err);
      }
    }
  };

  // Monitor Authentication and real-time roles lookup
  useEffect(() => {
    const unsubAuth = onAuthStateChanged(auth, async (user) => {
      if (user) {
        sessionStorage.removeItem('sandbox_deliberate_logout');
        const userObj = {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          emailVerified: user.emailVerified
        };
        try {
          localStorage.setItem('plsms_live_user', JSON.stringify(userObj));
        } catch (e) {}
        setCurrentUser(user);
        resolveUserRole(user);
        setAuthLoading(false);
      } else {
        const isDeliberateLogout = sessionStorage.getItem('sandbox_deliberate_logout') === 'true';
        const cachedUserStr = localStorage.getItem('plsms_live_user');
        if (!isDeliberateLogout && cachedUserStr) {
          try {
            const cachedUser = JSON.parse(cachedUserStr);
            if (cachedUser && (cachedUser.email || cachedUser.uid)) {
              setCurrentUser(cachedUser);
              const cachedRole = (localStorage.getItem('plsms_mock_user_role') || 'staff') as AppRole;
              setCurrentRole(cachedRole);
              resolveUserRole(cachedUser);
              setAuthLoading(false);
              return;
            }
          } catch (e) {}
        }
        localStorage.removeItem('plsms_live_user');
        localStorage.removeItem('plsms_mock_user_role');
        setCurrentUser(null);
        setCurrentRole('public');
        setAuthLoading(false);
      }
    });

    return () => {
      unsubAuth();
    };
  }, []);

  // Load dynamic Settings & Counter via one-time cached reads (Section 14)
  useEffect(() => {
    let isMounted = true;

    // Fast safety timeout: never stay stuck on initial loading for more than 800ms
    const safetyTimer = setTimeout(() => {
      if (isMounted) {
        setSettingsLoaded(true);
        setStatsLoaded(true);
        setIsInitialLoading(false);
      }
    }, 800);

    const loadSettingsAndStats = async () => {
      try {
        const timeoutPromise = new Promise((resolve) => setTimeout(resolve, 1000));
        const dataPromise = Promise.all([
          getOfficeSettings(),
          getSearchesServedCount()
        ]);

        const result = await Promise.race([dataPromise, timeoutPromise]);
        if (isMounted && Array.isArray(result)) {
          const [officeSet, totalServed] = result;
          setSettings(officeSet);
          setSearchesServed(totalServed);
        }
      } catch (err) {
        console.warn("Notice: Cached settings or statistics read notice:", err);
      } finally {
        if (isMounted) {
          setSettingsLoaded(true);
          setStatsLoaded(true);
          setIsInitialLoading(false);
        }
      }
    };

    loadSettingsAndStats();

    window.addEventListener('plsms_local_settings_changed', loadSettingsAndStats);
    return () => {
      isMounted = false;
      clearTimeout(safetyTimer);
      window.removeEventListener('plsms_local_settings_changed', loadSettingsAndStats);
    };
  }, [demoActive]);

  useEffect(() => {
    if (!authLoading) {
      setIsInitialLoading(false);
    }
  }, [authLoading, settingsLoaded, statsLoaded]);

  const [isSignInModalOpen, setIsSignInModalOpen] = useState(false);
  const [registeredUsers, setRegisteredUsers] = useState<UserRole[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeToUserRoles((users) => {
      if (users && users.length > 0) {
        setRegisteredUsers(users);
      }
    });
    return () => unsubscribe();
  }, [isSignInModalOpen, isPlsmsPath]);

  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [resetSentEmail, setResetSentEmail] = useState<string | null>(null);
  const [resetSentLoading, setResetSentLoading] = useState(false);





  // Sync authStaffName and reset inactivity tracker on currentUser changes
  useEffect(() => {
    if (currentUser) {
      lastActivityRef.current = Date.now();
      const name = currentUser.displayName || (currentUser as any).name || currentUser.email?.split('@')[0] || 'Authorized Staff';
      setAuthStaffName(name);
    } else {
      setAuthStaffName('');
    }
  }, [currentUser]);

  // 🕒 EFFICIENT INACTIVITY IDLE TIMEOUT MONITORING HOOK (TEMPORARILY DISABLED FOR DEVELOPMENT)
  useEffect(() => {
    // Disabled to prevent automatic logouts during development
    setShowSessionWarning(false);
    return;
  }, [currentUser, currentRole]);

  const handleContinueSession = () => {
    const now = Date.now();
    lastActivityRef.current = now;
    localStorage.setItem('plsms_last_activity_time', now.toString());
    setShowSessionWarning(false);
  };

  const autoLogoutOnIdle = async (expiredRole: string, durationMinutes: number) => {
    clearSessionCache();
    sessionStorage.setItem('sandbox_deliberate_logout', 'true');
    localStorage.removeItem('plsms_live_user');
    localStorage.removeItem('plsms_mock_user');
    localStorage.removeItem('plsms_mock_user_role');
    localStorage.removeItem('plsms_last_activity_time');
    
    // Clear all password fields immediately after logout
    setLoginPassword('');
    setTempPasswordInput('');
    setNewPasswordInput('');
    setNewPasswordConfirmInput('');
    
    // Set expired alert state so we can show a gorgeous alert modal overlay
    setSessionExpiredNotice("Your session has expired due to 5 minutes of inactivity. Please login again.");
    
    setIsPlsmsPath(false);
    try {
      window.history.pushState({}, '', '/');
    } catch (e) {}

    if (isDemoModeActive()) {
      setCurrentUser(null);
      setCurrentRole('public');
      setActiveTab('search');
    } else {
      try {
        await logOutFromApp();
      } catch (e) {}
      setCurrentUser(null);
      setCurrentRole('public');
      setActiveTab('search');
    }
  };

  const getActiveUserDisplayName = () => {
    if (!currentUser) return '';
    if (authStaffName) return authStaffName;
    if (currentUser.displayName) return currentUser.displayName;
    if (currentUser.email) {
      const emailName = currentUser.email.split('@')[0];
      return emailName.charAt(0).toUpperCase() + emailName.slice(1);
    }
    return 'Authorized Officer';
  };

  const resolveUserRole = async (user: User) => {
    setAuthLoading(true);
    let isAdminRole = false;
    try {
      // Define expected default/pattern-based roles based on user email
      let resolvedPatternRole: AppRole | null = null;
      let resolvedPatternDisplayName = '';
      const email = (user.email || '').toLowerCase();
      const isGoogleUser = (user.providerData && user.providerData.some(p => p.providerId === 'google.com')) || email === 'dahalkomal@gmail.com' || email.endsWith('@gmail.com');
      
      if (email === 'dahalkomal@gmail.com' || email.startsWith('dahalkomal_auto') || email.startsWith('superuser') || email.startsWith('superadmin')) {
        resolvedPatternRole = 'superuser';
        resolvedPatternDisplayName = email === 'dahalkomal@gmail.com' ? 'Komal Dahal' : 'Super Admin';
      } else if (email.startsWith('admin') || email.includes('admin') || email.includes('controller')) {
        resolvedPatternRole = 'admin';
        resolvedPatternDisplayName = 'Admin Officer';
      } else if (email.startsWith('staff') || email.includes('staff') || email.includes('operator')) {
        resolvedPatternRole = 'staff';
        resolvedPatternDisplayName = 'Office Staff';
      }

      // Direct lookup from users_roles DB with safe 2.5s timeout
      const isSuperUserTarget = email === 'dahalkomal@gmail.com' || resolvedPatternRole === 'superuser';
      const canonicalRoleId = isSuperUserTarget ? 'Super_Admin' : user.uid;
      let roleRef = doc(db, 'users_roles', canonicalRoleId);
      
      const roleSnap = await Promise.race([
        getDoc(roleRef),
        new Promise<any>((_, reject) => setTimeout(() => reject(new Error('role_read_timeout')), 2500))
      ]);
      
      if (roleSnap && roleSnap.exists && roleSnap.exists()) {
        const roleData = roleSnap.data();
        let role = (roleData.role as AppRole) || resolvedPatternRole || 'staff';
        let displayName = roleData.displayName || '';
        
        if (displayName === 'Super Admin (Lead)' || email === 'dahalkomal@gmail.com') {
          displayName = 'Komal Dahal';
          setDoc(roleRef, { displayName: 'Komal Dahal' }, { merge: true }).catch(() => {});
        }
        
        setAuthStaffName(displayName || user.displayName || user.email?.split('@')[0] || 'Authorized Operator');

        // HEALING MECHANISM: If the user email has a designated system pattern, but their database role is different (e.g., 'public'), force heal!
        if (resolvedPatternRole && role !== resolvedPatternRole) {
          console.log(`Healing role mismatch for ${email}. DB role is ${role}, but pattern requires ${resolvedPatternRole}. Updating...`);
          const defaultTempPass = (resolvedPatternRole === 'superuser' || resolvedPatternRole === 'admin') ? 'Itahari@PLSMS2083' : 'Itahari@2026';
          const healedRecord = {
            ...roleData,
            role: resolvedPatternRole,
            displayName: displayName || resolvedPatternDisplayName,
            updatedAt: new Date().toISOString(),
            temporaryPassword: isGoogleUser ? '' : defaultTempPass,
            mustChangePassword: isGoogleUser ? false : true
          };
          setDoc(roleRef, healedRecord).catch(() => {});
          role = resolvedPatternRole;
        }

        // Silent cleanup for lingering password-change triggers on Google Auth/Gmail users
        if (isGoogleUser && (roleData.mustChangePassword === true || roleData.temporaryPassword)) {
          setDoc(roleRef, {
            mustChangePassword: false,
            temporaryPassword: ''
          }, { merge: true }).catch(() => {});
        }

        setCurrentRole(role);
        if (role === 'superuser') isAdminRole = true;

        // Force check if they have a temporary password set and must change it on first login
        if (!isGoogleUser && (roleData.mustChangePassword === true || roleData.temporaryPassword)) {
          setMustChangeUserRecord({ id: roleSnap.id, ...roleData } as UserRole);
          setShowMustChangeModal(true);
        }
      } else {
        // Fallback from cache or default pattern
        const allRoles = await Promise.race([
          getAllUserRoles(),
          new Promise<UserRole[]>((resolve) => resolve(DEFAULT_CREDENTIALS_MATRIX))
        ]);
        const matchedUser = allRoles.find(r => r.email?.toLowerCase() === email || r.id === user.uid || (r.username && r.username.toLowerCase() === email));

        const resolvedRole: AppRole = matchedUser ? matchedUser.role : (resolvedPatternRole || (email === 'dahalkomal@gmail.com' ? 'superuser' : 'staff'));
        const resolvedDisplayName = matchedUser?.displayName || resolvedPatternDisplayName || user.displayName || user.email?.split('@')[0] || 'Authorized Operator';

        roleRef = doc(db, 'users_roles', user.uid);
        const defaultTempPassFresh = (resolvedRole === 'superuser' || resolvedRole === 'admin') ? 'Itahari@PLSMS2083' : 'Itahari@2026';
        const freshRecord = {
          email: email,
          role: resolvedRole,
          displayName: resolvedDisplayName,
          updatedAt: new Date().toISOString(),
          temporaryPassword: isGoogleUser ? '' : defaultTempPassFresh,
          mustChangePassword: isGoogleUser ? false : true
        };
        setDoc(roleRef, freshRecord).catch(() => {});

        if (!isGoogleUser && (matchedUser?.mustChangePassword || matchedUser?.temporaryPassword)) {
          setMustChangeUserRecord({ id: user.uid, ...freshRecord } as UserRole);
          setShowMustChangeModal(true);
        }

        setAuthStaffName(resolvedDisplayName);
        setCurrentRole(resolvedRole);
      }
    } catch (err) {
      if (isQuotaOrMemoryError(err)) {
        console.warn("Quota limit exceeded while checking role mapping table. Falling back gracefully.");
      } else {
        console.warn("Role mapping table check fallback notice: ", err);
      }
      checkAndTriggerQuotaError(err);
      
      const email = (user.email || '').toLowerCase();
      if (email === 'dahalkomal@gmail.com' || email.startsWith('dahalkomal_auto') || email.startsWith('superuser') || email.startsWith('superadmin')) {
        setCurrentRole('superuser');
        setAuthStaffName(email === 'dahalkomal@gmail.com' ? 'Komal Dahal' : 'Super Admin');
      } else if (email.startsWith('admin') || email.includes('admin') || email.includes('controller')) {
        setCurrentRole('admin');
        setAuthStaffName('Admin Officer');
      } else if (email.startsWith('staff') || email.includes('staff') || email.includes('operator')) {
        setCurrentRole('staff');
        setAuthStaffName('Office Staff');
      } else {
        const fallbackRole = (localStorage.getItem('plsms_mock_user_role') as AppRole) || 'staff';
        setCurrentRole(fallbackRole);
        setAuthStaffName(user.displayName || user.email?.split('@')[0] || 'Authorized Operator');
      }
    } finally {
      setAuthLoading(false);
    }
  };

  const handleRoleChanged = () => {
    if (isDemoModeActive()) {
      const mockUserStr = localStorage.getItem('plsms_mock_user');
      if (mockUserStr) {
        setCurrentUser(JSON.parse(mockUserStr));
        setCurrentRole((localStorage.getItem('plsms_mock_user_role') || 'staff') as AppRole);
      }
    } else if (auth.currentUser) {
      resolveUserRole(auth.currentUser);
    } else {
      const cachedFileUserStr = localStorage.getItem('plsms_live_user');
      if (cachedFileUserStr) {
        try {
          const cachedUser = JSON.parse(cachedFileUserStr);
          setCurrentUser(cachedUser);
          const cachedRole = (localStorage.getItem('plsms_mock_user_role') || 'staff') as AppRole;
          setCurrentRole(cachedRole);
        } catch (e) {}
      }
    }
  };

  const toggleAuth = async () => {
    if (currentUser) {
      sessionStorage.setItem('sandbox_deliberate_logout', 'true');
      localStorage.removeItem('plsms_live_user');
      localStorage.removeItem('plsms_mock_user');
      localStorage.removeItem('plsms_mock_user_role');
      
      // Clear all password fields immediately after logout
      setLoginPassword('');
      setTempPasswordInput('');
      setNewPasswordInput('');
      setNewPasswordConfirmInput('');

      setIsPlsmsPath(false);
      try {
        window.history.pushState({}, '', '/');
      } catch (e) {}

      if (isDemoModeActive()) {
        setCurrentUser(null);
        setCurrentRole('public');
        setActiveTab('search');
      } else {
        await logOutFromApp();
        setCurrentUser(null);
        setCurrentRole('public');
        setActiveTab('search');
      }
    } else {
      setSignInError(null);
      setLoginEmail('');
      setLoginPassword('');
      setIsSignInModalOpen(true);
    }
  };

  const handleGoogleSignIn = async () => {
    setSignInLoading(true);
    setSignInError(null);
    try {
      if (isDemoModeActive()) {
        // Instant simulated Google login with superuser privileges as fallback
        const mockUser = { uid: 'Super_Admin', email: 'dahalkomal@gmail.com', displayName: 'Komal Dahal' };
        localStorage.setItem('plsms_mock_user', JSON.stringify(mockUser));
        localStorage.setItem('plsms_mock_user_role', 'superuser');
        setCurrentUser(mockUser as any);
        setCurrentRole('superuser');
        setIsSignInModalOpen(false);
        if (activeTab === 'search') {
          setActiveTab('dashboard');
        }
      } else {
        await startGoogleSignIn();
        setIsSignInModalOpen(false);
      }
    } catch (err: any) {
      console.error(err);
      setSignInError("Google sign-in popup blocked or closed. For iframes, please use the direct Email Credentials below.");
    } finally {
      setSignInLoading(false);
    }
  };

  const findMatchingUserWithInput = (input: string, userList?: UserRole[]): UserRole | null => {
    if (!input || !input.trim()) return null;
    const list = userList && userList.length > 0 ? userList : registeredUsers;
    const cleanInputRaw = input.trim();
    const cleanInput = cleanInputRaw.toLowerCase();
    const inputPrefix = cleanInput.includes('@') ? cleanInput.split('@')[0] : cleanInput;
    const inputAlpha = inputPrefix.replace(/[^a-z0-9]/gi, '');

    // 1. Direct User Name / User ID / ID / Email Prefix Match
    const matchByUsername = list.find(u => {
      const uUsername = (u.username || '').trim().toLowerCase();
      const uUserId = ((u as any).userId || '').trim().toLowerCase();
      const uId = (u.id || '').trim().toLowerCase();
      const uEmail = (u.email || '').trim().toLowerCase();
      const uEmailPrefix = uEmail.includes('@') ? uEmail.split('@')[0] : uEmail;

      return (
        uUsername === cleanInput ||
        uUserId === cleanInput ||
        uId === cleanInput ||
        uEmail === cleanInput ||
        uUsername === inputPrefix ||
        uUserId === inputPrefix ||
        uId === inputPrefix ||
        uEmailPrefix === inputPrefix ||
        (uUsername && uUsername.replace(/[^a-z0-9]/gi, '') === inputAlpha) ||
        (uUserId && uUserId.replace(/[^a-z0-9]/gi, '') === inputAlpha) ||
        (uEmailPrefix && uEmailPrefix.replace(/[^a-z0-9]/gi, '') === inputAlpha)
      );
    });
    if (matchByUsername) return matchByUsername;

    // 2. Direct Mobile Match
    const cleanMobileInput = cleanInputRaw.replace(/[^0-9]/g, '');
    if (cleanMobileInput.length >= 7) {
      const matchByMobile = list.find(u => {
        if (!u.mobile) return false;
        const mobClean = u.mobile.trim().replace(/[^0-9]/g, '');
        return mobClean === cleanMobileInput || u.mobile.trim() === cleanInputRaw;
      });
      if (matchByMobile) return matchByMobile;
    }

    // 3. Direct Email Match
    if (cleanInput.includes('@')) {
      const match = list.find(u => u.email && u.email.toLowerCase().trim() === cleanInput);
      if (match) return match;
    }

    // 4. Role-based Username match (exact mapping of usernameStr in the settings pane registry list)
    const matchByRoleUsernameStr = list.find(u => {
      let usernameStr = '';
      const emailLower = (u.email || '').toLowerCase();
      if (emailLower === 'dahalkomal@gmail.com') {
        usernameStr = 'superadmin';
      } else if (emailLower.includes('@')) {
        usernameStr = emailLower.split('@')[0];
      } else {
        usernameStr = (u.displayName || 'staff').replace(/\s+/g, '').toLowerCase();
      }
      return usernameStr === cleanInput || usernameStr.replace(/[^a-z0-9]/g, '') === cleanInput.replace(/[^a-z0-9]/g, '');
    });
    if (matchByRoleUsernameStr) return matchByRoleUsernameStr;

    // 5. Email prefix/username check
    const matchByEmailPrefix = list.find(u => {
      if (!u.email) return false;
      const parts = u.email.split('@')[0].toLowerCase();
      return parts === cleanInput || parts.replace(/[^a-z0-9]/g, '') === cleanInput.replace(/[^a-z0-9]/g, '');
    });
    if (matchByEmailPrefix) return matchByEmailPrefix;

    // 6. Display Name match
    const matchByDisplayName = list.find(u => {
      if (!u.displayName) return false;
      const dNameClean = u.displayName.toLowerCase().trim();
      if (dNameClean === cleanInput || dNameClean.replace(/\s+/g, '') === cleanInput.replace(/\s+/g, '')) return true;
      const words = dNameClean.split(/\s+/);
      return words.some(w => w === cleanInput || w.replace(/[^a-z0-9]/g, '') === cleanInput.replace(/[^a-z0-9]/g, ''));
    });
    if (matchByDisplayName) return matchByDisplayName;

    // 7. Direct ID or mobile match
    const matchByIdOrMobile = list.find(u => u.id.toLowerCase() === cleanInput || (u.mobile && u.mobile.trim() === cleanInputRaw));
    if (matchByIdOrMobile) return matchByIdOrMobile;

    return null;
  };

  const handleEmailSignInSubmit = async (e?: React.FormEvent, explicitEmail?: string, explicitPass?: string) => {
    if (e) e.preventDefault();
    const emailToUse = (explicitEmail || loginEmail || '').trim();
    const passToUse = explicitPass || loginPassword || '';

    if (!emailToUse || !passToUse) {
      setSignInError("Please enter both username/email and password.");
      return;
    }
    setSignInLoading(true);
    setSignInError(null);
    try {
      // 🔍 Fetch latest user roles directly from DB / cache with safe timeout
      let allRoles: UserRole[] = [];
      try {
        const rolesPromise = getAllUserRoles(true);
        const timeoutPromise = new Promise<UserRole[]>((resolve) => 
          setTimeout(() => resolve(registeredUsers && registeredUsers.length > 0 ? registeredUsers : DEFAULT_CREDENTIALS_MATRIX), 2500)
        );
        allRoles = await Promise.race([rolesPromise, timeoutPromise]);
        if (allRoles && allRoles.length > 0) {
          setRegisteredUsers(allRoles);
        }
      } catch (err) {
        console.warn("Could not query DB roles on sign-in submit:", err);
        allRoles = registeredUsers && registeredUsers.length > 0 ? registeredUsers : DEFAULT_CREDENTIALS_MATRIX;
      }

      // Support Username/Name login lookup using fresh allRoles
      let matchedDBUser: UserRole | undefined = findMatchingUserWithInput(emailToUse, allRoles) || undefined;
      let resolvedEmail = matchedDBUser?.email?.toLowerCase() || emailToUse.toLowerCase();

      if (!matchedDBUser && resolvedEmail.includes('@')) {
        const emailMatches = allRoles.filter(r => r.email && r.email.toLowerCase() === resolvedEmail);
        if (emailMatches.length > 0) {
          matchedDBUser = emailMatches.find(r => !!r.customStoredPassword) || emailMatches[0];
        }
      }

      const isSuperUserCheck = resolvedEmail === 'dahalkomal@gmail.com' || 
                               emailToUse.toLowerCase() === 'dahalkomal@gmail.com' ||
                               emailToUse.toLowerCase() === 'super_admin';

      // Auto-provision Super Admin if not found in database roles
      if (!matchedDBUser && isSuperUserCheck) {
        matchedDBUser = {
          id: 'Super_Admin',
          username: 'Super_Admin',
          email: 'dahalkomal@gmail.com',
          role: 'superuser',
          displayName: 'Komal Dahal',
          updatedAt: new Date().toISOString()
        } as UserRole;
      }

      // STRICT REGISTRATION & ACTIVE CREDENTIAL CHECK
      if (!matchedDBUser) {
        setSignInError("Access Denied: This account is not registered. Sign-in is restricted to registered staff only.");
        setSignInLoading(false);
        return;
      }

      // Enforce status check (if user account is suspended, cancel immediately)
      if (matchedDBUser.status === 'SUSPENDED') {
        setSignInError("This operator account has been Suspended. Contact System Administrator.");
        setSignInLoading(false);
        return;
      }

      // STRICT MANDATORY PASSWORD VALIDATION GATE
      let isPasswordValid = false;
      try {
        const verifyPromise = verifyUserPassword(matchedDBUser, passToUse);
        const verifyTimeout = new Promise<boolean>((resolve) => 
          setTimeout(() => resolve(false), 3000)
        );
        isPasswordValid = await Promise.race([verifyPromise, verifyTimeout]);
      } catch (e) {
        console.warn("Password verification check error:", e);
      }

      if (!isPasswordValid) {
        setSignInError("सङ्केत-शब्द मिलेन (Incorrect Password): परिवर्तन गरिएको वा अद्यावधिक गरिएको नयाँ पासवर्ड (Updated Password) प्रयोग गर्नुहोस्।");
        setSignInLoading(false);
        setLoginPassword('');
        return;
      }

      // Record active password session metadata for real-time synchronization
      try {
        const passHashToRecord = matchedDBUser.passwordHash || (await hashCredential(passToUse));
        const verToRecord = matchedDBUser.passwordVersion || 1;
        sessionStorage.setItem('plsms_session_pwd_version', String(verToRecord));
        sessionStorage.setItem('plsms_session_pwd_hash', passHashToRecord);
        sessionStorage.setItem('plsms_session_user_id', matchedDBUser.id);
      } catch (e) {}

      // 🔓 2. Setup the signed-in session via Firebase Auth with safe fallback
      sessionStorage.removeItem('sandbox_deliberate_logout');
      let user: any = null;
      try {
        user = await startEmailSignIn(resolvedEmail, passToUse);
      } catch (innerErr: any) {
        console.warn("Firebase Auth sign-in note:", innerErr);
      }

      if (!user || !user.uid) {
        const fallbackUid = matchedDBUser ? matchedDBUser.id : (isSuperUserCheck ? 'Super_Admin' : `user_${resolvedEmail.replace(/[^a-z0-9]/g, '_')}`);
        user = {
          uid: fallbackUid,
          email: resolvedEmail,
          displayName: matchedDBUser.displayName || resolvedEmail.split('@')[0],
          emailVerified: true
        };
      }

      const assignedRole = matchedDBUser.role || (isSuperUserCheck ? 'superuser' : 'staff');
      const assignedName = matchedDBUser.displayName || resolvedEmail.split('@')[0] || 'Authorized Operator';

      setCurrentUser(user);
      try {
        localStorage.setItem('plsms_live_user', JSON.stringify(user));
        localStorage.setItem('plsms_mock_user_role', assignedRole);
      } catch (e) {}

      setCurrentRole(assignedRole);
      setAuthStaffName(assignedName);

      try {
        await Promise.race([
          resolveUserRole(user),
          new Promise((resolve) => setTimeout(resolve, 2000))
        ]);
      } catch (roleErr) {
        console.warn("Background role resolution note:", roleErr);
      }

      if (activeTab === 'search') {
        setActiveTab('dashboard');
      }
      setLoginPassword('');
      setIsSignInModalOpen(false);
    } catch (err: any) {
      console.error("Sign-in process error:", err);
      setSignInError(err?.message || "Authentication error. Access Denied.");
    } finally {
      setSignInLoading(false);
    }
  };

  const handleChangePasswordSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!mustChangeUserRecord) return;
    
    setChangePasswordError(null);
    setChangePasswordSuccess(false);
    
    if (!tempPasswordInput) {
      setChangePasswordError("Please enter your current temporary password.");
      return;
    }
    
    const isTempPasswordValid = await verifyUserPassword(mustChangeUserRecord, tempPasswordInput);
    if (!isTempPasswordValid) {
      setChangePasswordError("The current temporary password you entered is incorrect.");
      return;
    }
    
    const pwdValidation = validateStrongPassword(newPasswordInput);
    if (!pwdValidation.isValid) {
      setChangePasswordError(pwdValidation.message || "Invalid password format.");
      return;
    }
    
    if (newPasswordInput !== newPasswordConfirmInput) {
      setChangePasswordError("New password and confirmation fields do not match.");
      return;
    }
    
    setChangePasswordLoading(true);
    try {
      const passHash = await hashCredential(newPasswordInput);
      const currentVer = mustChangeUserRecord.passwordVersion || 1;
      const nextVer = currentVer + 1;
      const now = new Date().toISOString();

      if (auth.currentUser) {
        try {
          await updatePassword(auth.currentUser, newPasswordInput);
        } catch (updateErr: any) {
          console.warn("Notice: Firebase Auth password update:", updateErr);
        }
      }

      await saveUserRole(mustChangeUserRecord.id, {
        ...mustChangeUserRecord,
        mustChangePassword: false,
        passwordHash: passHash,
        passwordVersion: nextVer,
        passwordLastChanged: now,
        isCustomPassword: true,
        updatedAt: now,
        updatedBy: mustChangeUserRecord.email
      });

      sessionStorage.setItem('plsms_session_pwd_version', String(nextVer));
      sessionStorage.setItem('plsms_session_pwd_hash', passHash);
      
      setChangePasswordSuccess(true);
      setTempPasswordInput('');
      setNewPasswordInput('');
      setNewPasswordConfirmInput('');
      
      setTimeout(() => {
        setShowMustChangeModal(false);
        setMustChangeUserRecord(null);
        setChangePasswordSuccess(false);
      }, 1500);
    } catch (err: any) {
      console.error(err);
      setTempPasswordInput('');
      setNewPasswordInput('');
      setNewPasswordConfirmInput('');
      setChangePasswordError(err?.message || "Failed to change temporary password. Please try again.");
    } finally {
      setChangePasswordLoading(false);
    }
  };

  const populateQuickCreds = async (email: string) => {
    setLoginEmail(email);
    
    // Resolve expectation dynamically so developer quick login buttons still work perfectly even after we change passwords!
    const isSuperEmail = email.toLowerCase() === 'dahalkomal@gmail.com' || email.toLowerCase() === 'dahalutkrishta@gmail.com';
    let expectedPass = isSuperEmail ? 'Itahari@PLSMS2083' : 'Itahari@2026';
    try {
      const allRoles = await getAllUserRoles();
      const match = allRoles.find(r => r.email.toLowerCase() === email.toLowerCase());
      if (match) {
        if (match.customStoredPassword) {
          expectedPass = match.customStoredPassword;
        } else if (match.temporaryPassword) {
          expectedPass = match.temporaryPassword;
        }
      }
    } catch (e) {
      console.warn("Could not dynamically lookup quick credential password:", e);
    }

    setLoginPassword(expectedPass);
    await handleEmailSignInSubmit(undefined, email, expectedPass);
  };

  const isSuperUser = currentUser !== null && effectiveRole === 'superuser';

  useEffect(() => {
    if (authLoading || isInitialLoading) return;
    // Any authenticated user is allowed to access non-public tabs without being forcefully redirected
    if (currentUser) {
      return;
    }
    if (!isStaff && activeTab !== 'search' && activeTab !== 'notices') {
      setActiveTab('search');
    }
  }, [isStaff, activeTab, authLoading, isInitialLoading, currentUser]);

  // 🔒 Real-Time Cross-Browser Multi-Session Invalidation Watcher
  useEffect(() => {
    if (!currentUser) return;
    const sessionUserId = sessionStorage.getItem('plsms_session_user_id') || currentUser.uid;
    if (!sessionUserId) return;

    const userDocRef = doc(db, 'users_roles', sessionUserId);
    const unsubscribe = onSnapshot(userDocRef, (snap) => {
      if (!snap.exists()) return;
      const liveData = snap.data();
      const liveVersion = liveData.passwordVersion || 1;
      const liveHash = liveData.passwordHash;

      const sessionVersion = Number(sessionStorage.getItem('plsms_session_pwd_version') || '1');
      const sessionHash = sessionStorage.getItem('plsms_session_pwd_hash');

      if (sessionHash && (liveVersion > sessionVersion || (liveHash && liveHash !== sessionHash))) {
        console.warn("Notice: Session invalidated by remote password update! Signing out immediately.");
        sessionStorage.removeItem('plsms_session_pwd_version');
        sessionStorage.removeItem('plsms_session_pwd_hash');
        sessionStorage.removeItem('plsms_session_user_id');
        logOutFromApp();
        setCurrentUser(null);
        setCurrentRole(null);
        setMustChangeUserRecord(null);
        setShowMustChangeModal(false);
        setSignInError("⚠️ पासवर्ड परिवर्तन भइसकेको छ: तपाईँको खाताको पासवर्ड प्रशासक वा अर्को सेसनबाट अद्यावधिक गरिएकोले कृपया नयाँ पासवर्ड प्रयोग गरी पुनः लगइन गर्नुहोस्।");
        setIsSignInModalOpen(true);
      }
    }, (err) => {
      console.warn("Notice: Real-time session watcher status:", err);
    });

    return () => unsubscribe();
  }, [currentUser]);

  const renderLoginCard = () => {
    const isSignInBtnDisabled = signInLoading || loginEmail.trim().length === 0 || loginPassword.trim().length === 0;

    return (
      <div className="flex flex-col items-center justify-center w-full max-w-[430px] font-sans mx-auto py-4">
        {/* Top Back Button (Matching Picture 1) */}
        <button
          onClick={() => {
            if (isPlsmsPath) {
              window.location.href = '/';
            } else {
              setIsSignInModalOpen(false);
            }
          }}
          type="button"
          className="flex items-center gap-2 px-5 py-2.5 bg-white border border-slate-200/90 rounded-xl shadow-xs hover:bg-slate-50 text-[#1e3a8a] text-xs sm:text-sm font-bold transition-all active:scale-95 cursor-pointer tracking-wide mb-6 border-b-2"
        >
          <span>←</span> नागरिक खोज गृहपृष्ठ (Back to Citizen Search)
        </button>

        {/* Main Card Container (Matching Picture 1) */}
        <div className="w-full bg-white rounded-2xl border border-slate-200/90 shadow-xl overflow-hidden transition-all duration-200">
          
          {/* National Blue Header Block with Red Line */}
          <div className="bg-[#1e3a8a] px-6 py-6 text-center border-b-[4px] border-[#da251d] relative">
            {/* Lock Badge Icon */}
            <div className="mx-auto w-11 h-11 rounded-full bg-white/10 flex items-center justify-center border border-white/20 mb-2.5">
              <Lock className="w-5 h-5 text-white" />
            </div>

            {/* Title */}
            <h3 className="font-extrabold text-white text-base sm:text-lg tracking-wide">
              प्रशासकीय लगइन (Admin Portal)
            </h3>

            {/* Subtitle */}
            <p className="text-[10px] sm:text-[11.5px] text-blue-100/90 font-medium mt-1 tracking-wide">
              यातायात व्यवस्था कार्यालय, स.चा.अ.प., इटहरी, सुनसरी
            </p>
          </div>

          {/* Form Body Area */}
          <div className="p-6 sm:p-7 space-y-4">
            
            {/* Login Attempt Error */}
            {signInError && (
              <div className="p-3.5 bg-red-50 border border-red-200 text-xs rounded-xl">
                <div className="flex items-start gap-2 text-red-700">
                  <span className="font-extrabold shrink-0 text-sm">⚠️</span>
                  <div className="space-y-0.5">
                    <p className="font-bold">Login Attempt Denied</p>
                    <p className="leading-relaxed text-slate-600 text-[11px]">{signInError}</p>
                  </div>
                </div>
              </div>
            )}

            {/* Field 1: Username / Email */}
            <div className="space-y-1.5">
              <label className="text-[11px] sm:text-xs font-bold tracking-wide flex items-center gap-1.5 text-slate-800">
                <Users className="w-3.5 h-3.5 text-[#1e3a8a] shrink-0" />
                <span>युजरनेम / इमेल (Username / Email)</span>
              </label>
              <input
                type="text"
                required
                autoComplete="off"
                value={loginEmail}
                placeholder="उदा. admin@gmail.com"
                onChange={(e) => setLoginEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !isSignInBtnDisabled) handleEmailSignInSubmit(); }}
                className="w-full bg-slate-50/80 border border-slate-200/90 rounded-lg px-3.5 py-2.5 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#1e3a8a] focus:ring-1 focus:ring-[#1e3a8a] transition-all font-medium"
              />
            </div>

            {/* Field 2: Password */}
            <div className="space-y-1.5">
              <label className="text-[11px] sm:text-xs font-bold tracking-wide flex items-center gap-1.5 text-slate-800">
                <span>पासवर्ड (Password)</span>
              </label>
              <div className="relative">
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  autoComplete="current-password"
                  value={loginPassword}
                  placeholder="पासवर्ड प्रविष्ट गर्नुहोस्"
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !isSignInBtnDisabled) handleEmailSignInSubmit(); }}
                  className="w-full bg-slate-50/80 border border-slate-200/90 rounded-lg pl-3.5 pr-10 py-2.5 text-xs text-slate-900 placeholder-slate-400 focus:outline-none focus:border-[#1e3a8a] focus:ring-1 focus:ring-[#1e3a8a] transition-all font-medium"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 transition-colors focus:outline-none cursor-pointer"
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Login Submit Button (Matching Picture 1) */}
            <button
              type="button"
              onClick={() => handleEmailSignInSubmit()}
              disabled={isSignInBtnDisabled}
              className="w-full py-2.5 sm:py-3 mt-1.5 bg-[#1d4ed8] hover:bg-[#1e40af] text-white font-bold rounded-lg text-xs sm:text-sm tracking-wide flex items-center justify-center gap-1.5 transition-all shadow-md active:scale-95 disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer"
            >
              {signInLoading ? 'प्रक्रिया हुँदैछ (SIGNING IN...)' : 'लगइन गर्नुहोस् (LOGIN)'}
            </button>
          </div>

          {/* Footer Security Disclaimer inside Card (Matching Picture 1) */}
          <div className="bg-slate-50/80 p-4 border-t border-slate-100 text-center">
            <p className="text-[10.5px] sm:text-[11.5px] text-slate-600 leading-relaxed font-medium">
              सुरक्षित लगइन कुञ्जी बिना यो प्रणाली पहुँच गर्न सकिँदैन। <br />
              सहायताको लागि वितरण प्रणाली विभागमा सम्पर्क गर्नुहोस्।
            </p>
          </div>

        </div>
      </div>
    );
  };

  const onSearchExecuted = () => {
    // Called when the searches score is incremented
  };

  const currentMenuTitle = React.useMemo(() => {
    switch (activeTab) {
      case 'search':
        return (settings.searchMenuLabel || 'Search').toUpperCase();
      case 'notices':
        return (settings.noticesMenuLabel || 'Notices').toUpperCase();
      case 'dashboard':
        return 'SMART CARD DASHBOARD';
      case 'reports':
        return 'REPORTS';
      case 'requests':
        return 'REQUESTS QUEUE';
      case 'settings':
        return effectiveRole === 'admin' ? 'STAFF REGISTRY' : 'SETTINGS';
      default:
        return '';
    }
  }, [activeTab, settings.searchMenuLabel, settings.noticesMenuLabel, effectiveRole]);

  // 1. Unauthenticated staff navigating to /plsms MUST see the login panel IMMEDIATELY with zero blocking gates
  if (isPlsmsPath && !isStaff) {
    if (authLoading) {
      return (
        <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-4 font-sans text-center">
          <div className="w-10 h-10 border-4 border-cyan-500 border-t-transparent rounded-full animate-spin mb-4 mx-auto" />
          <h3 className="text-slate-200 font-extrabold text-sm tracking-wide">प्रमाणीकरण जाँच हुँदैछ (Verifying Security Credentials...)</h3>
          <p className="text-slate-400 text-xs mt-1">Please wait while verifying administrator access rights...</p>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex items-center justify-center p-3 sm:p-4 font-sans bg-[#f1f5f9] text-slate-900 antialiased">
        {renderLoginCard()}
      </div>
    );
  }

  // 2. Fallback system loading for initial state resolution
  if (isInitialLoading) {
    return (
      <div className={`min-h-screen flex flex-col items-center justify-center font-sans antialiased transition-colors duration-200 ${
        theme === 'dark' ? 'bg-slate-950 text-white' : 'bg-slate-50 text-slate-900'
      }`}>
        <div className="flex flex-col items-center gap-5">
          {/* Permanent Nepal Emblem Logo during loading with reliable fallback */}
          <img 
            src="/nepal-emblem.svg" 
            alt="Government of Nepal Emblem" 
            className="w-20 h-20 sm:w-24 sm:h-24 object-contain rounded-xl shrink-0 drop-shadow-md" 
            onError={(e) => {
              (e.target as HTMLImageElement).src = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="%231e3a8a" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
            }}
          />
          <div className="relative mt-2">
            {/* Elegant high-performance loader */}
            <div className="w-10 h-10 rounded-full border-4 border-cyan-500/20 border-t-cyan-500 animate-spin" />
            <div className="absolute inset-0 w-10 h-10 rounded-full border-4 border-transparent border-b-cyan-400 animate-spin opacity-50" style={{ animationDirection: 'reverse', animationDuration: '0.6s' }} />
          </div>
          <div className="flex flex-col items-center gap-1 text-center px-4">
            <span className="font-sans font-black text-xs uppercase tracking-widest text-cyan-500 animate-pulse">
              System Loading...
            </span>
            <span className="font-mono text-[9px] text-slate-500 uppercase tracking-widest leading-relaxed">
              Initializing Secure Environment
            </span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PageTitleProvider defaultTitle={currentMenuTitle}>
      <div className={`min-h-screen font-sans selection:bg-cyan-900 selection:text-white antialiased transition-colors duration-200 ${
        !isStaff
          ? 'bg-slate-50 py-2 sm:py-8 px-1 sm:px-4 flex flex-col justify-center items-center'
          : theme === 'dark' 
            ? 'bg-slate-950 text-slate-100 selection:bg-cyan-950 selection:text-cyan-400' 
            : 'bg-slate-50 text-slate-900 selection:bg-cyan-200 selection:text-cyan-900'
      }`}>
        <div className={!isStaff 
          ? "w-full max-w-5xl bg-white border-2 sm:border-[3px] border-[#1e3a8a] rounded-2xl sm:rounded-3xl overflow-hidden shadow-2xl flex flex-col"
          : `mx-auto w-full max-w-[1440px] xl:max-w-[1600px] 2xl:max-w-[1800px] min-h-screen flex flex-col justify-between border-x transition-all duration-200 ${
              theme === 'dark'
                ? 'bg-slate-900 border-slate-800 shadow-2xl'
                : 'bg-[#faf6ee] border-[#1e3a8a] shadow-xl'
            }`
        }>
          <header className={!isStaff ? "w-full overflow-hidden" : `transition-all duration-200 mx-4 sm:mx-14 md:mx-32 lg:mx-40 xl:mx-48 mt-4 rounded-2xl md:rounded-3xl overflow-hidden shadow-md border ${
            theme === 'dark' ? 'border-slate-800 bg-slate-900' : 'border-slate-200/60 bg-white'
          }`}>
            {/* National Blue Government Banner (Picture 2 theme) */}
            <div className={`${theme === 'dark' ? 'bg-slate-900 border-b-0' : 'bg-[#1e3a8a] border-b-4 border-[#da251d]'} text-white relative overflow-hidden shadow-md`}>
              {/* Subtle texture layer */}
              <div className="absolute inset-0 bg-gradient-to-r from-blue-950/25 via-transparent to-blue-950/25 pointer-events-none" />
              
              <div className={`mx-auto px-3.5 sm:px-6 py-1.5 sm:py-2 relative z-10 ${!isStaff ? 'w-full' : 'max-w-full'}`}>
                
                {/* Mobile / Tablet Responsive Layout (< 768px) */}
                <div className="flex flex-col gap-2.5 md:hidden w-full">
                  {/* Top Section: Logo + Title & Address + Date/Time & QR */}
                  <div className="flex items-start justify-between gap-2 min-w-0 w-full">
                    
                    {/* Left: Emblem + Office Name & Address */}
                    <div className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer select-none" onClick={() => setActiveTab('search')}>
                      <img 
                        src={settings.officeLogo && !settings.officeLogo.includes("placeholder") ? settings.officeLogo : "/nepal-emblem.svg"} 
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "/nepal-emblem.svg";
                        }}
                        alt="Government of Nepal Emblem" 
                        className="w-10 h-10 min-[360px]:w-12 min-[360px]:h-12 min-[412px]:w-14 min-[412px]:h-14 sm:w-16 sm:h-16 object-contain shrink-0 drop-shadow-sm" 
                      />
                      <div className="min-w-0 flex-1">
                        <h1 className="font-bold text-[12.5px] min-[360px]:text-[14px] min-[390px]:text-[15.5px] min-[430px]:text-[17px] sm:text-xl tracking-tight leading-snug text-white">
                          {settings.officeName || "Transport Management Office, Driving License"}
                        </h1>
                        <p className="text-[10px] min-[360px]:text-[11px] sm:text-xs font-extrabold uppercase tracking-wider text-white mt-0.5 truncate">
                          {settings.officeAddress || "Itahari, Sunsari, Nepal"}
                        </p>
                      </div>
                    </div>

                    {/* Right: Date, Time & QR */}
                    <div className="flex flex-col items-end shrink-0 gap-1 text-right">
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setShowQrModal(true);
                          }}
                          type="button"
                          title="View System QR Code"
                          className="bg-transparent hover:bg-white/10 border border-white/35 hover:border-white/60 text-white rounded-xl px-2.5 py-1 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer animate-pulse backdrop-blur-xs"
                        >
                          <QrCode className="w-3.5 h-3.5 text-white shrink-0" />
                          <span className="text-xs font-black tracking-wider text-white uppercase">QR CODE</span>
                        </button>

                        {isAdmin && (
                          <button
                            onClick={() => setUserTheme(userTheme === 'dark' ? 'light' : 'dark')}
                            type="button"
                            title="Toggle Dark/Light Mode"
                            className="p-1 rounded-full text-white transition-all duration-300 active:scale-90 cursor-pointer hover:bg-white/10"
                          >
                            {userTheme === 'dark' ? <Sun className="w-3.5 h-3.5 text-amber-300" /> : <Moon className="w-3.5 h-3.5 text-cyan-200" />}
                          </button>
                        )}
                      </div>

                      {/* Nepali Clock Widget */}
                      <div className="text-right flex flex-col items-end">
                        <NepaliClockWidget />
                      </div>
                    </div>
                  </div>

                  {/* Bottom Row on Mobile: User Session Panel or Staff Login (if applicable) */}
                  <div className="flex items-center justify-between gap-2 pt-1.5 border-t border-white/15 w-full">
                    {currentUser ? (
                      <div className="flex items-center justify-between w-full gap-2">
                        <div className="flex items-center gap-1.5 bg-blue-950/50 border border-white/20 px-2 py-0.5 rounded-md shadow-inner min-w-0">
                          <span className="relative flex h-1.5 w-1.5 shrink-0">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                          </span>
                          <span className="text-[10px] sm:text-[11px] font-bold text-slate-200 font-mono truncate max-w-[130px] min-[360px]:max-w-[180px] sm:max-w-[240px]">
                            {(currentUser.email || 'STAFF').toUpperCase()}
                          </span>
                          <span className="text-[8px] font-black uppercase tracking-wider px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 shrink-0">
                            {effectiveRole === 'superuser' ? 'SU' : effectiveRole === 'admin' ? 'AD' : 'ST'}
                          </span>
                        </div>
                        <button
                          onClick={toggleAuth}
                          type="button"
                          className="bg-[#da251d] hover:bg-red-700 text-white text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded transition-all active:scale-95 cursor-pointer shadow-xs shrink-0"
                        >
                          LOG OUT
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end w-full">
                        <button
                          onClick={toggleAuth}
                          type="button"
                          className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold uppercase tracking-widest px-3 py-1 rounded transition-all active:scale-95 cursor-pointer shadow-xs"
                        >
                          STAFF LOGIN
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Desktop Layout (>= 768px, md:) - Kept Pixel-Perfect Unchanged */}
                <div className="hidden md:flex md:items-center justify-between gap-4 w-full">
                  {/* Left Side: Logo & Office Details */}
                  <div className="flex items-center gap-4 cursor-pointer select-none min-w-0" onClick={() => setActiveTab('search')}>
                    <div className="relative shrink-0">
                      <img 
                        src={settings.officeLogo && !settings.officeLogo.includes("placeholder") ? settings.officeLogo : "/nepal-emblem.svg"} 
                        onError={(e) => {
                          (e.target as HTMLImageElement).src = "/nepal-emblem.svg";
                        }}
                        alt="Government of Nepal Emblem" 
                        className="w-20 h-20 object-contain shrink-0 relative z-10 drop-shadow-sm" 
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-bold text-2xl md:text-[25px] block tracking-tight leading-tight text-white whitespace-nowrap">
                        {settings.officeName || "Transport Management Office, Driving License"}
                      </span>
                      {settings.officeAddress && (
                        <div className="flex items-center justify-between gap-2 mt-1 w-full">
                          <span className="text-sm font-extrabold uppercase tracking-wider block text-white truncate">
                            {settings.officeAddress || "Itahari, Sunsari, Nepal"}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Right Side: QR Code, Date, Time, and Theme Changer */}
                  <div className="flex flex-col items-end justify-center gap-1.5 shrink-0 select-none text-right">
                    <div className="flex items-center gap-2 shrink-0">
                      {/* QR Code Button */}
                      <button
                        onClick={() => setShowQrModal(true)}
                        type="button"
                        title="View System QR Code"
                        className="bg-transparent hover:bg-white/10 border border-white/35 hover:border-white/60 text-white rounded-xl px-3 py-1 flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer animate-pulse backdrop-blur-xs"
                      >
                        <QrCode className="w-4 h-4 text-white shrink-0" />
                        <span className="text-xs sm:text-sm font-black tracking-wider text-white uppercase">QR CODE</span>
                      </button>

                      {/* Theme Changer Icon Button */}
                      {isAdmin && (
                        <button
                          onClick={() => setUserTheme(userTheme === 'dark' ? 'light' : 'dark')}
                          type="button"
                          title="Toggle Dark/Light Mode"
                          className="p-1 rounded-full text-white transition-all duration-300 active:scale-90 cursor-pointer hover:bg-white/10"
                        >
                          {userTheme === 'dark' ? <Sun className="w-4 h-4 text-amber-300" /> : <Moon className="w-4 h-4 text-cyan-200" />}
                        </button>
                      )}

                      {/* LOG OUT / STAFF LOGIN button */}
                      {currentUser ? (
                        <button
                          onClick={toggleAuth}
                          type="button"
                          className="bg-[#da251d] hover:bg-red-700 text-white text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded transition-all active:scale-95 cursor-pointer shadow-xs"
                        >
                          LOG OUT
                        </button>
                      ) : (
                        isPlsmsPath && (
                          <button
                            onClick={toggleAuth}
                            type="button"
                            className="bg-emerald-600 hover:bg-emerald-700 text-white text-[10px] font-bold uppercase tracking-widest px-2.5 py-1 rounded transition-all active:scale-95 cursor-pointer shadow-xs"
                          >
                            STAFF LOGIN
                          </button>
                        )
                      )}
                    </div>
                    
                    {/* Isolated Nepali Clock Widget */}
                    <div className="text-right flex flex-col items-end my-0.5">
                      <NepaliClockWidget />
                    </div>

                    {/* Compact Session Info */}
                    {currentUser && (
                      <div className="flex items-center gap-2 bg-blue-950/50 border border-white/20 px-2.5 py-0.5 rounded-md shadow-inner backdrop-blur-xs">
                        <span className="relative flex h-1.5 w-1.5">
                          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                        </span>
                        <span className="text-[11px] font-bold text-slate-200 font-mono">
                          {(currentUser.email || 'STAFF').toUpperCase()}
                        </span>
                        <span className="text-[9px] font-black uppercase tracking-wider px-1 py-0.2 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30">
                          {effectiveRole === 'superuser' ? 'SU' : effectiveRole === 'admin' ? 'AD' : 'ST'}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>

            {/* Navigation Tabs Bar sits beautifully below the national blue banner */}
            <div className={`px-2 sm:px-6 py-2 border-b transition-colors duration-200 ${
              theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}>
              <div className={`mx-auto w-full transition-all duration-300 ${!isStaff ? 'max-w-7xl' : 'max-w-full'}`}>
                <div className="w-full overflow-x-auto scrollbar-none py-0.5">
                  <div className={`flex flex-row flex-nowrap justify-start items-center gap-1.5 p-1 rounded-xl border transition-all w-fit min-w-0 ${
                    theme === 'dark' ? 'bg-slate-950/40 border-slate-800' : 'bg-slate-100/60 border-slate-200'
                  }`}>
                    <a
                      href={`${window.location.origin}${window.location.pathname}`}
                      draggable="true"
                      onDragStart={(e) => {
                        try {
                          const fullUrl = `${window.location.origin}${window.location.pathname}`;
                          e.dataTransfer.setData("text/plain", fullUrl);
                          e.dataTransfer.setData("text/uri-list", fullUrl);
                        } catch (err) {
                          console.error("Drag start error", err);
                        }
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        setActiveTab('search');
                      }}
                      className={`px-2.5 xs:px-3 py-1 rounded-lg text-[10px] xs:text-[11px] sm:text-xs font-bold transition-all border uppercase cursor-pointer text-center whitespace-nowrap ${
                        activeTab === 'search' 
                          ? theme === 'dark'
                            ? 'bg-slate-900 text-cyan-400 border-slate-700 shadow-sm' 
                            : 'bg-white text-cyan-700 border-slate-200 shadow-xs'
                          : theme === 'dark'
                            ? 'text-slate-400 hover:text-white border-transparent bg-transparent'
                            : 'text-slate-600 hover:text-slate-900 border-transparent bg-transparent'
                      }`}
                    >
                      <span>
                        {settings.searchMenuLabel || 'Search'}
                      </span>
                    </a>
                    <a
                      href={`${window.location.origin}${window.location.pathname}?tab=notices`}
                      draggable="true"
                      onDragStart={(e) => {
                        try {
                          const fullUrl = `${window.location.origin}${window.location.pathname}?tab=notices`;
                          e.dataTransfer.setData("text/plain", fullUrl);
                          e.dataTransfer.setData("text/uri-list", fullUrl);
                        } catch (err) {
                          console.error("Drag start error", err);
                        }
                      }}
                      onClick={(e) => {
                        e.preventDefault();
                        setActiveTab('notices');
                      }}
                      className={`px-2.5 xs:px-3 py-1 rounded-lg text-[10px] xs:text-[11px] sm:text-xs font-bold transition-all border uppercase cursor-pointer text-center whitespace-nowrap ${
                        activeTab === 'notices' 
                          ? theme === 'dark'
                            ? 'bg-slate-900 text-cyan-400 border-slate-700 shadow-sm' 
                            : 'bg-white text-cyan-700 border-slate-200 shadow-xs'
                          : theme === 'dark'
                            ? 'text-slate-400 hover:text-white border-transparent bg-transparent'
                            : 'text-slate-600 hover:text-slate-900 border-transparent bg-transparent'
                      }`}
                    >
                      <span>
                        {settings.noticesMenuLabel || 'NOTICES'}
                      </span>
                    </a>

              {/* Smart Card Dashboard */}
              {isStaff && (
                <a
                  href={`${window.location.origin}${window.location.pathname}?tab=dashboard`}
                  draggable="true"
                  onDragStart={(e) => {
                    try {
                      const fullUrl = `${window.location.origin}${window.location.pathname}?tab=dashboard`;
                      e.dataTransfer.setData("text/plain", fullUrl);
                      e.dataTransfer.setData("text/uri-list", fullUrl);
                    } catch (err) {
                      console.error("Drag start error", err);
                    }
                  }}
                  onClick={(e) => {
                    e.preventDefault();
                    handleSelectTab('dashboard');
                  }}
                  className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 cursor-pointer border uppercase ${
                    activeTab === 'dashboard' 
                      ? 'bg-cyan-600 text-white border-cyan-500 shadow-sm' 
                      : theme === 'dark'
                        ? 'text-slate-400 hover:text-white border-transparent bg-transparent'
                        : 'text-slate-600 hover:text-slate-950 border-transparent bg-transparent'
                  }`}
                >
                  <LayoutDashboard className="w-3.5 h-3.5" />
                  SMART CARD DASHBOARD
                </a>
              )}

              {/* Reports, Requests Queue, and Settings */}
              {isStaff && (
                <>
                  <a
                    href={`${window.location.origin}${window.location.pathname}?tab=reports`}
                    draggable="true"
                    onDragStart={(e) => {
                      try {
                        const fullUrl = `${window.location.origin}${window.location.pathname}?tab=reports`;
                        e.dataTransfer.setData("text/plain", fullUrl);
                        e.dataTransfer.setData("text/uri-list", fullUrl);
                      } catch (err) {
                        console.error("Drag start error", err);
                      }
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      handleSelectTab('reports');
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer border uppercase ${
                      activeTab === 'reports' 
                        ? 'bg-cyan-600 text-white border-cyan-500 shadow-sm' 
                        : theme === 'dark'
                          ? 'text-slate-400 hover:text-white border-transparent bg-transparent'
                          : 'text-slate-600 hover:text-slate-950 border-transparent bg-transparent'
                    }`}
                  >
                    REPORTS
                  </a>

                  <a
                    href={`${window.location.origin}${window.location.pathname}?tab=requests`}
                    draggable="true"
                    onDragStart={(e) => {
                      try {
                        const fullUrl = `${window.location.origin}${window.location.pathname}?tab=requests`;
                        e.dataTransfer.setData("text/plain", fullUrl);
                        e.dataTransfer.setData("text/uri-list", fullUrl);
                      } catch (err) {
                        console.error("Drag start error", err);
                      }
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      handleSelectTab('requests');
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer border uppercase ${
                      activeTab === 'requests' 
                        ? 'bg-cyan-600 text-white border-cyan-500 shadow-sm' 
                        : theme === 'dark'
                          ? 'text-slate-400 hover:text-white border-transparent bg-transparent'
                          : 'text-slate-600 hover:text-slate-950 border-transparent bg-transparent'
                    }`}
                  >
                    REQUESTS QUEUE
                  </a>

                  <a
                    href={`${window.location.origin}${window.location.pathname}?tab=settings`}
                    draggable="true"
                    onDragStart={(e) => {
                      try {
                        const fullUrl = `${window.location.origin}${window.location.pathname}?tab=settings`;
                        e.dataTransfer.setData("text/plain", fullUrl);
                        e.dataTransfer.setData("text/uri-list", fullUrl);
                      } catch (err) {
                        console.error("Drag start error", err);
                      }
                    }}
                    onClick={(e) => {
                      e.preventDefault();
                      handleSelectTab('settings');
                    }}
                    className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center gap-1.5 border cursor-pointer uppercase ${
                      activeTab === 'settings' 
                        ? theme === 'dark'
                          ? 'bg-slate-900 text-cyan-400 border-slate-700 shadow-sm' 
                          : 'bg-white text-cyan-700 border-slate-200/50 shadow-xs'
                        : theme === 'dark'
                          ? 'text-slate-400 hover:text-white border-transparent bg-transparent'
                          : 'text-slate-600 hover:text-slate-900 border-transparent bg-transparent'
                    }`}
                  >
                    <Settings className="w-3.5 h-3.5 text-cyan-500" />
                    {effectiveRole === 'admin' ? 'Staff Registry' : 'SETTINGS'}
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
      </header>

      {/* Dynamic Page Title Header displayed in plain screen outside of the card */}
      <PageHeader />

      {/* Main Container Content */}
      <main className={`flex-1 transition-all duration-300 pt-1 pb-8 ${
        !isStaff 
          ? "w-full mx-auto px-2 sm:px-4 max-w-7xl" 
          : "mx-4 sm:mx-14 md:mx-32 lg:mx-40 xl:mx-48"
      }`}>
        
        {activeTab === 'search' && (
          <PublicSearch
            officeName={settings.officeName}
            officeAddress={settings.officeAddress}
            officeLogo={settings.officeLogo}
            bannerText={settings.homepageBanner || ''}
            contactNumber={settings.contactNumber || ''}
            onSearchExecuted={onSearchExecuted}
            theme={theme}
            currentRole={effectiveRole}
            userEmail={currentUser?.email || ''}
          />
        )}

        {activeTab === 'notices' && (
          <NoticeBoard 
            isAdmin={isAdmin} 
            isSuperuser={isSuperUser} 
            theme={theme} 
            currentUserDisplayName={currentUser?.displayName || undefined}
          />
        )}



        {activeTab === 'dashboard' && (
          isStaff ? (
            <StaffDashboard userRole={effectiveRole} userEmail={currentUser?.email || ''} theme={theme} viewMode="dashboard" />
          ) : (
            <div className={`max-w-md mx-auto text-center p-8 border rounded-2xl ${
              theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-md'
            }`}>
              <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4 animate-bounce" />
              <h2 className={`text-sm font-black uppercase tracking-wider ${theme === 'dark' ? 'text-slate-300' : 'text-slate-800'}`}>Dashboard Access Restricted</h2>
              <p className="text-xs text-slate-500 mt-2 mb-6 leading-relaxed">
                Authorized operators and administrators can access the Smart Card Dashboard.
              </p>
              <button
                onClick={() => setIsSignInModalOpen(true)}
                className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/25 text-white rounded-xl text-xs font-bold active:scale-95 transition-all cursor-pointer"
              >
                Sign In to View Dashboard
              </button>
            </div>
          )
        )}

        {activeTab === 'reports' && (
          isStaff ? (
            <StaffDashboard userRole={effectiveRole} userEmail={currentUser?.email || ''} theme={theme} viewMode="reports" />
          ) : (
            <div className={`max-w-md mx-auto text-center p-8 border rounded-2xl ${
              theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-md'
            }`}>
              <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4 animate-bounce" />
              <h2 className={`text-sm font-black uppercase tracking-wider ${theme === 'dark' ? 'text-slate-300' : 'text-slate-800'}`}>Reports Access Restricted</h2>
              <p className="text-xs text-slate-500 mt-2 mb-6 leading-relaxed">
                Authorized operators and administrators can access the Print Reports Terminal.
              </p>
              <button
                onClick={() => setIsSignInModalOpen(true)}
                className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/25 text-white rounded-xl text-xs font-bold active:scale-95 transition-all cursor-pointer"
              >
                Sign In to View Reports
              </button>
            </div>
          )
        )}
 
        {activeTab === 'requests' && (
          isStaff ? (
            <RequestManager theme={theme} />
          ) : (
            <div className={`max-w-md mx-auto text-center p-8 border rounded-2xl ${
              theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-md'
            }`}>
              <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4 animate-bounce" />
              <h2 className={`text-sm font-black uppercase tracking-wider ${theme === 'dark' ? 'text-slate-300' : 'text-slate-800'}`}>Requests Queue Secured</h2>
              <p className="text-xs text-slate-500 mt-2 mb-6 leading-relaxed">
                This area tracks smart card pickup queues and approvals. Sign in as office personnel to handle request pipelines.
              </p>
              <button
                onClick={() => setIsSignInModalOpen(true)}
                className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/25 text-white rounded-xl text-xs font-bold active:scale-95 transition-all cursor-pointer"
              >
                Sign In of Personnel
              </button>
            </div>
          )
        )}
 
        {activeTab === 'settings' && (
          isStaff ? (
            <SettingsPanel currentSettings={settings} onSettingsUpdate={(newSettings) => setSettings(newSettings)} currentUserRole={effectiveRole} currentUserEmail={currentUser?.email || undefined} theme={theme} setUserTheme={setUserTheme} onSelectTab={handleSelectTab} />
          ) : (
            <div className={`max-w-md mx-auto text-center p-8 border rounded-2xl ${
              theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200 shadow-md'
            }`}>
              <Settings className="w-12 h-12 text-red-500 mx-auto mb-4 animate-spin-slow" />
              <h2 className={`text-sm font-black uppercase tracking-wider ${theme === 'dark' ? 'text-slate-300' : 'text-slate-800'}`}>Super Admin Settings Required</h2>
              <p className="text-xs text-slate-500 mt-2 mb-6 leading-relaxed">
                The global TMODL, Itahari office configuration console is restricted strictly to Lead Superuser Administrators.
              </p>
              <button
                onClick={() => setIsSignInModalOpen(true)}
                className="px-5 py-2.5 bg-cyan-600 hover:bg-cyan-500 hover:shadow-lg hover:shadow-cyan-500/25 text-white rounded-xl text-xs font-bold active:scale-95 transition-all cursor-pointer"
              >
                Super Admin Sign-In
              </button>
            </div>
          )
        )}
      </main>

      {/* 🔐 STAFF AUTHENTICATION MODAL */}
      {isSignInModalOpen && (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-3 sm:p-4 overflow-y-auto font-sans transition-all duration-300 bg-[#f1f5f9]">
          {renderLoginCard()}
        </div>
      )}

      {/* Dynamic System Sandbox Switching (For developer quick reviews securely) */}
      {typeof window !== "undefined" && localStorage.getItem('plsms_dev_mode') === 'true' && (
        <DevSwitcher
          currentRole={effectiveRole}
          userEmail={currentUser ? currentUser.email : null}
          onRoleChanged={handleRoleChanged}
        />
      )}

      {/* 🔐 FIRST-TIME SIGN-IN COMPULSORY PASSWORD CHANGE GATE */}
      {showMustChangeModal && mustChangeUserRecord && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 backdrop-blur-md p-4 animate-fade-in">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl w-full max-w-md p-6 shadow-2xl relative font-sans">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-4 border-b border-slate-800/60 mb-5">
              <div className="flex items-center gap-2">
                <Shield className="w-5 h-5 text-amber-500 animate-pulse" />
                <h3 className="font-extrabold text-white text-base">Compulsory Password Change</h3>
              </div>
              <button 
                onClick={async () => {
                  // If they reject setting a password, we log them out to keep system secure
                  sessionStorage.setItem('sandbox_deliberate_logout', 'true');
                  
                  // Clear all password fields immediately after logout
                  setLoginPassword('');
                  setTempPasswordInput('');
                  setNewPasswordInput('');
                  setNewPasswordConfirmInput('');

                  if (isDemoModeActive()) {
                    localStorage.removeItem('plsms_mock_user');
                    localStorage.removeItem('plsms_mock_user_role');
                    setCurrentUser(null);
                    setCurrentRole('public');
                    setActiveTab('search');
                  } else {
                    await logOutFromApp();
                    setActiveTab('search');
                  }
                  setShowMustChangeModal(false);
                  setMustChangeUserRecord(null);
                }}
                className="text-[10px] uppercase font-bold text-slate-400 hover:text-red-400 px-2.5 py-1.5 rounded-lg hover:bg-slate-800 transition-colors"
              >
                Sign Out / Exit
              </button>
            </div>

            {/* Introductory Instruction - beautifully styled flash card with reasoning text information */}
            <div className="mb-5 bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-inner">
              <div className="bg-gradient-to-r from-amber-600/10 to-transparent p-3.5 border-b border-slate-800/60 flex items-center gap-2">
                <Shield className="w-5 h-5 text-amber-500 animate-pulse shrink-0" />
                <span className="font-extrabold text-[11px] uppercase tracking-wider text-amber-400 font-sans">
                  पहिलो पटकको लगइन सुरक्षा नीति (First Login Security Policy)
                </span>
              </div>
              
              <div className="p-4 space-y-3 text-xs text-slate-300">
                <p className="leading-relaxed">
                  The account <strong className="text-white">{mustChangeUserRecord.email}</strong> was signed in using a default or administrator-assigned temporary password (<strong>{mustChangeUserRecord.temporaryPassword || (mustChangeUserRecord.role === 'superuser' || mustChangeUserRecord.role === 'admin' ? 'Itahari@PLSMS2083' : 'Itahari@2026')}</strong>).
                </p>

                {/* reasoning text block / beautiful flash card style */}
                <div className="bg-slate-900/60 border border-slate-800 p-3 rounded-xl space-y-2">
                  <span className="block text-[10px] font-extrabold text-slate-400 uppercase tracking-widest border-b border-slate-800 pb-1">
                    यसकारण पासवर्ड परिवर्तन आवश्यक छ (Reasoning Details):
                  </span>
                  <ul className="space-y-1.5 text-[11px] text-slate-350 list-none pl-0">
                    <li className="flex items-start gap-1.5">
                      <span className="text-amber-500 shrink-0 font-bold">•</span>
                      <span><strong>असुरक्षित पूर्वनिर्धारित चाबी:</strong> System-wide default password is publicly known and insecure.</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-amber-500 shrink-0 font-bold">•</span>
                      <span><strong>लेखापरीक्षण सुरक्षा (Audit Compliance):</strong> Changing the password ensures legal and cryptographic compliance for document ledgers.</span>
                    </li>
                    <li className="flex items-start gap-1.5">
                      <span className="text-amber-500 shrink-0 font-bold">•</span>
                      <span><strong>डिजिटल हस्ताक्षर संरक्षण:</strong> Prevents unauthorized operators from issuing license receipts under your registry credentials.</span>
                    </li>
                  </ul>
                </div>

                <p className="text-[11px] text-slate-400 leading-relaxed font-sans">
                  तपाईंले प्रवेस गर्नुभएको पूर्वनिर्धारित अस्थायी पासवर्डलाई परिमार्जन गरी नयाँ गोप्य सुरक्षित पासवर्ड राख्न अनिवार्य छ ।
                </p>
              </div>
            </div>

            {/* Error / Success messages */}
            {changePasswordError && (
              <div className="mb-4 p-3 bg-red-950/20 border border-red-900/40 text-xs text-red-400 rounded-xl">
                ⚠️ {changePasswordError}
              </div>
            )}

            {changePasswordSuccess && (
              <div className="mb-4 p-3 bg-emerald-950/20 border border-emerald-900/40 text-xs text-emerald-400 rounded-xl font-bold flex items-center gap-1.5">
                ✅ Password changed successfully! Loading administrative portal...
              </div>
            )}

            {/* Password Change Form */}
            <div className="space-y-4">
              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block mb-1.5">Current Temporary Password</label>
                <input
                  type="text"
                  required
                  autoComplete="current-password"
                  placeholder="Enter the password given by superadmin"
                  value={tempPasswordInput}
                  onChange={(e) => setTempPasswordInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors secure-masked font-mono"
                  disabled={changePasswordLoading || changePasswordSuccess}
                />
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block mb-1.5">New Personal Password</label>
                <input
                  type="text"
                  required
                  autoComplete="new-password"
                  placeholder="At least 6 characters long"
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors secure-masked"
                  disabled={changePasswordLoading || changePasswordSuccess}
                />
              </div>

              <div>
                <label className="text-[10px] uppercase font-bold text-slate-400 tracking-wider block mb-1.5">Confirm New Password</label>
                <input
                  type="text"
                  required
                  autoComplete="new-password"
                  placeholder="Type new password again"
                  value={newPasswordConfirmInput}
                  onChange={(e) => setNewPasswordConfirmInput(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-3.5 py-2.5 text-xs text-white focus:outline-none focus:border-cyan-500 transition-colors secure-masked"
                  disabled={changePasswordLoading || changePasswordSuccess}
                />
              </div>

              <button
                type="button"
                onClick={() => handleChangePasswordSubmit()}
                disabled={changePasswordLoading || changePasswordSuccess}
                className="w-full py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold rounded-xl text-xs flex items-center justify-center gap-1.5 active:scale-95 transition-all shadow-lg shadow-emerald-900/20 cursor-pointer disabled:opacity-50"
              >
                {changePasswordLoading ? 'Saving secure credentials...' : 'Establish Secure Password & Log In'}
              </button>
            </div>

          </div>
        </div>
      )}

      {/* ⚠️ SESSION EXPIRING WARNING MODAL */}
      {showSessionWarning && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in font-sans">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 shadow-2xl relative">
            <div className="flex justify-center mb-5">
              <div className="relative">
                <div className="absolute inset-0 bg-yellow-500/10 rounded-full blur-xl animate-pulse"></div>
                <div className="relative flex items-center justify-center w-16 h-16 bg-slate-950 border border-slate-800/60 rounded-full shadow-xl">
                  <span className="text-xl font-bold text-yellow-500 animate-pulse">{warningSecondsLeft}s</span>
                </div>
              </div>
            </div>

            <h3 className="font-extrabold text-white text-base sm:text-lg text-center tracking-tight leading-snug">
              Session Expiring
            </h3>
            
            <p className="text-xs text-slate-300 mt-4 text-center leading-relaxed bg-slate-950/50 p-4 rounded-2xl border border-slate-800 shadow-inner">
              No activity has been detected.<br />
              Your session will expire in <strong className="text-yellow-500">{warningSecondsLeft} seconds</strong>.
            </p>

            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={handleContinueSession}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold uppercase text-xs tracking-wider rounded-2xl shadow-lg hover:shadow-emerald-900/40 transition-all active:scale-95 cursor-pointer text-center"
              >
                Continue Session
              </button>
              <button
                type="button"
                onClick={() => autoLogoutOnIdle('superuser', 5)}
                className="w-full py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-extrabold uppercase text-xs tracking-wider rounded-2xl transition-all active:scale-95 cursor-pointer text-center"
              >
                Logout Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ⌛ INACTIVITY SESSION EXPIRED WARNING MODAL */}
      {sessionExpiredNotice && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md animate-fade-in font-sans">
          <div className="bg-slate-900 border border-slate-800 rounded-3xl max-w-md w-full p-6 shadow-2xl relative">
            <div className="flex justify-center mb-5">
              <div className="relative">
                <div className="absolute inset-0 bg-rose-500/10 rounded-full blur-xl animate-pulse"></div>
                <div className="relative flex items-center justify-center w-16 h-16 bg-slate-950 border border-slate-800/60 rounded-full shadow-xl">
                  <AlertCircle className="w-8 h-8 text-rose-500 animate-bounce" />
                </div>
              </div>
            </div>

            <h3 className="font-extrabold text-white text-base sm:text-lg text-center tracking-tight leading-snug">
              सत्रको म्याद सकियो ! (Session Inactivity Timeout)
            </h3>
            
            <p className="text-xs text-slate-350 mt-4 text-center leading-relaxed bg-slate-950/50 p-4 rounded-2xl border border-slate-800 shadow-inner">
              {sessionExpiredNotice}
            </p>

            <div className="mt-6 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => {
                  setSessionExpiredNotice(null);
                  toggleAuth(); // Open login modal straightaway so they can sign in!
                }}
                className="w-full py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-extrabold uppercase text-xs tracking-wider rounded-2xl shadow-lg hover:shadow-cyan-900/40 transition-all active:scale-95 cursor-pointer text-center"
              >
                Sign In Again (पुनः लगइन गर्नुहोस्)
              </button>
              <button
                type="button"
                onClick={() => setSessionExpiredNotice(null)}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-750 text-slate-400 hover:text-slate-200 font-bold uppercase text-xs tracking-normal rounded-2xl transition-all cursor-pointer text-center"
              >
                Dismiss (हटाउनुहोस्)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Dynamic S7 search counter and styling Footer */}
      {!isStaff ? (
        <div className="py-2.5 px-4 bg-white mt-auto border-t border-slate-100">
          <div className="mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-xs font-medium">
            <div className="text-center md:text-left text-[8.5px] xs:text-[10px] sm:text-[11.5px] font-normal text-slate-700 tracking-normal max-w-xl space-y-0.5 sm:space-y-1">
              {(() => {
                const footerText = settings.websiteFooter || "© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance.";
                if (footerText.includes("All operations are logged")) {
                  const parts = footerText.split(/(?=All operations are logged)/i);
                  return (
                    <>
                      <div className="leading-snug text-slate-700 font-normal">{parts[0].trim()}</div>
                      <div className="leading-snug text-[7.5px] xs:text-[9px] sm:text-[10.5px] font-normal text-slate-600">
                        {parts[1] ? parts[1].trim() : "All operations are logged and monitored for security compliance."}
                      </div>
                    </>
                  );
                }
                if (footerText.includes("Authorized Use Only")) {
                  const parts = footerText.split(/(?=Authorized Use Only)/i);
                  return (
                    <>
                      <div className="leading-snug text-slate-700 font-normal">{parts[0].trim()}</div>
                      <div className="leading-snug text-[7.5px] xs:text-[9px] sm:text-[10.5px] font-normal text-slate-600">
                        {parts[1] ? parts[1].trim() : "Authorized Use Only."}
                      </div>
                    </>
                  );
                }
                if (footerText.includes("All Rights Reserved")) {
                  const parts = footerText.split(/(?=All Rights Reserved)/i);
                  return (
                    <>
                      <div className="leading-snug text-slate-700 font-normal">{parts[0].trim()}</div>
                      <div className="leading-snug text-[7.5px] xs:text-[9px] sm:text-[10.5px] font-normal text-slate-600">
                        All Rights Reserved.
                      </div>
                    </>
                  );
                }
                // Fallback splitting by period if too long
                if (footerText.length > 50 && footerText.includes(".")) {
                  const firstPeriod = footerText.indexOf(".");
                  const line1 = footerText.substring(0, firstPeriod + 1).trim();
                  const line2 = footerText.substring(firstPeriod + 1).trim();
                  return (
                    <>
                      <div className="leading-snug text-slate-700 font-normal">{line1}</div>
                      {line2 && <div className="leading-snug text-[7.5px] xs:text-[9px] sm:text-[10.5px] font-normal text-slate-600">{line2}</div>}
                    </>
                  );
                }
                return <div className="leading-snug text-slate-700 font-normal">{footerText}</div>;
              })()}
            </div>

            {/* S7 SEARCH COUNTER */}
            <div className="px-4 py-1.5 sm:px-6 sm:py-2 rounded-lg sm:rounded-xl flex flex-col items-center justify-center gap-0.5 shrink-0 border border-cyan-200 bg-white shadow-xs min-w-[140px] sm:min-w-[180px]">
              <span className="font-mono text-sm sm:text-lg font-black tracking-wider leading-tight text-blue-600">
                {searchesServed.toLocaleString()}
              </span>
              <span className="text-[8.5px] sm:text-[9.5px] uppercase font-extrabold tracking-wider text-slate-600">
                VISITOR SEARCH COUNTER
              </span>
            </div>
          </div>
        </div>
      ) : (
        <footer className={`py-2.5 px-6 font-sans border-t transition-colors ${
          theme === 'dark' 
            ? 'bg-slate-900 text-slate-400 border-slate-800' 
            : 'bg-gradient-to-r from-sky-50/60 via-slate-50/80 to-sky-50/60 text-slate-600 border-cyan-100/70 shadow-inner'
        }`}>
          <div className={!isStaff ? `mx-auto flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-medium transition-all duration-300 max-w-7xl` : `transition-all duration-200 mx-4 sm:mx-14 md:mx-32 lg:mx-40 xl:mx-48 flex flex-col md:flex-row items-center justify-between gap-4 text-xs font-medium`}>
            <div className="text-center md:text-left space-y-1">
              <span className={`font-black block uppercase tracking-wide ${theme === 'dark' ? 'text-white' : 'text-slate-805 text-cyan-950'}`}>{settings.officeName}</span>
              <span className={`block ${theme === 'dark' ? 'text-slate-400 font-normal' : 'text-slate-600 font-normal'}`}>{settings.websiteFooter || '© 2026 Transport Management Office, Driving License, Itahari, Sunsari. Authorized Use Only. All operations are logged and monitored for security compliance.'}</span>
            </div>

            {/* S7 SEARCH COUNTER */}
            <div className={`px-8 py-3 rounded-2xl flex flex-col items-center justify-center gap-0.5 shrink-0 border transition-all text-center min-w-[210px] ${
              theme === 'dark' 
                ? 'bg-slate-950 border-slate-800 shadow-lg' 
                : 'bg-white border-cyan-200 shadow-xs'
            }`}>
              <span className={`font-mono text-lg font-black tracking-wider leading-tight ${
                theme === 'dark' ? 'text-blue-400' : 'text-blue-600'
              }`}>
                {searchesServed.toLocaleString()}
              </span>
              <span className={`text-[9.5px] uppercase font-extrabold tracking-wider ${
                theme === 'dark' ? 'text-slate-300' : 'text-slate-600'
              }`}>
                VISITOR SEARCH COUNTER
              </span>
            </div>
          </div>
        </footer>
      )}

      {/* Interactive QR Code Modal */}
      {showQrModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs transition-opacity duration-300">
          <div className="w-full max-w-[480px] rounded-3xl overflow-hidden shadow-2xl border border-slate-200 bg-white text-slate-900 transition-all transform scale-100 flex flex-col">
            {/* Header */}
            <div className="p-4 flex items-center justify-between bg-[#1e3a8a] text-white border-b-4 border-[#da251d]">
              <div className="flex items-center gap-2">
                <QrCode className="w-5 h-5 text-white" />
                <span className="font-extrabold text-sm tracking-wide">Share PLSMS</span>
              </div>
              <button
                onClick={() => setShowQrModal(false)}
                className="text-white/80 hover:text-white transition-colors cursor-pointer p-1 rounded-lg hover:bg-white/10"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            
            {/* Body */}
            <div className="p-5 sm:p-6 flex flex-col items-center bg-white w-full">
              {/* Top: Office Name in Big Font - strictly single line */}
              <div className="w-full text-center overflow-x-auto no-scrollbar py-0.5">
                <h2 className="text-[#1e3a8a] font-black text-[14px] sm:text-[16px] md:text-[17px] text-center leading-tight tracking-tight whitespace-nowrap inline-block">
                  Transport Management Office, Driving License
                </h2>
              </div>
              
              {/* Office Address: font size approximately half of Office Name */}
              <p className="text-slate-600 font-bold text-[11px] sm:text-[12px] text-center mt-0.5 mb-4">
                Itahari, Sunsari
              </p>

              {/* Dashed QR Box wrapper */}
              <div className="border-2 border-dashed border-[#1e3a8a] rounded-3xl p-5 flex items-center justify-center bg-white w-full max-w-[220px] aspect-square shadow-xs mb-4">
                <img
                  src={`https://api.qrserver.com/v1/create-qr-code/?size=300x300&color=1e3a8a&data=${encodeURIComponent('https://plsms.onrender.com/')}`}
                  alt="QR Code"
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                />
              </div>

              {/* System Title in Single Line */}
              <div className="w-full text-center overflow-x-auto no-scrollbar py-1">
                <h3 className="text-[#1e3a8a] font-extrabold text-[11px] sm:text-[12px] md:text-[13px] text-center whitespace-nowrap tracking-tight inline-block">
                  Printed License Search Management System (PLSMS)
                </h3>
              </div>

              {/* Website Link Display Pill */}
              <div className="w-full bg-blue-50/70 border border-blue-100 text-[#1e3a8a] text-xs font-mono font-bold py-2.5 px-3 rounded-xl text-center select-all shadow-inner tracking-tight mt-3">
                https://plsms.onrender.com/
              </div>
            </div>

            {/* Footer Area with grey background */}
            <div className="bg-slate-50 border-t border-slate-100 p-5 flex flex-col gap-3">
              {/* Row 1: Action Buttons side by side */}
              <div className="flex gap-3">
                <button
                  onClick={handleDownloadQr}
                  type="button"
                  className="bg-[#1e3a8a] hover:bg-blue-800 text-white font-extrabold text-xs py-2.5 px-3 rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition-all active:scale-95 flex-1 cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download PNG</span>
                </button>
                
                <button
                  onClick={handlePrintQr}
                  type="button"
                  className="bg-[#da251d] hover:bg-red-700 text-white font-extrabold text-xs py-2.5 px-3 rounded-xl flex items-center justify-center gap-1.5 shadow-sm transition-all active:scale-95 flex-1 cursor-pointer"
                >
                  <Printer className="w-4 h-4" />
                  <span>Print QR</span>
                </button>
              </div>

              {/* Row 2: Copy link & Close button side by side */}
              <div className="flex gap-3">
                <button
                  onClick={handleCopyLink}
                  type="button"
                  className="bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-extrabold text-xs py-2.5 px-3 rounded-xl flex items-center justify-center gap-1.5 shadow-xs flex-1 transition-all active:scale-95 cursor-pointer"
                >
                  <Copy className="w-4 h-4" />
                  <span>{copied ? 'Copied!' : 'Copy Website Link'}</span>
                </button>

                <button
                  onClick={() => setShowQrModal(false)}
                  type="button"
                  className="bg-[#475569] hover:bg-slate-700 text-white font-extrabold text-xs py-2.5 px-3 rounded-xl flex items-center justify-center flex-1 transition-all active:scale-95 cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      
      {/* Quota warning banner has been removed per user instructions to keep the layout clean and professional */}
        </div>
      </div>
    </PageTitleProvider>
  );
}
