export type LicenseStatus = 'available' | 'distributed' | 'missing' | 'found';
export type RequestStatus = 'pending' | 'approved' | 'completed' | 'cancelled';
export type AppRole = 'superuser' | 'admin' | 'staff' | 'public';

export interface LicenseLog {
  timestamp: string;
  action: string;
  user: string;
  details: string;
}

export interface License {
  id: string; // Document ID (usually applicantId or licenseNumber for unique referencing)
  applicantId: string;
  fullName: string;
  fatherHusbandName?: string;
  licenseNumber: string;
  category?: string;
  contactDepartment?: string;
  officeVisitDay?: string;
  receivedBy?: string;
  status: LicenseStatus;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  logs?: LicenseLog[];
  mobileNumber?: string;
  missingDate?: string;
  missingTime?: string;
  missingBy?: string;
  markedBy?: string;
  foundDate?: string;
  foundTime?: string;
  foundBy?: string;
  recoveredBy?: string;
  distributedBy?: string;
  distributionDate?: string;
  remarks?: string;
  uploadId?: string;
  oldCode?: string;
  newCode?: string;
  isDuplicate?: boolean;
  sn?: number;
  distributedByStaffName?: string;
  submittedDocs?: string[];
  submittedDocsOther?: string;
  submittedDocsSavedBy?: string;
  submittedDocsSavedDate?: string;
  submittedDocsSavedTime?: string;
  distributedDate?: string;
  submittedDocsUpdatedBy?: string;
  submittedDocsUpdatedDate?: string;
  submittedDocsResetBy?: string;
  submittedDocsResetDate?: string;
  submittedDocsReceiverName?: string;
  recommendedStaffName?: string;
  recommended_staff_name?: string;
  distributed?: boolean;
  distributionStatus?: string;
  distributedTo?: string;
}

export interface UploadLedger {
  id: string; // UPLOAD ID
  timestamp: string; // DATE & TIME
  fileName: string;
  size: string;
  actionType: string;
  noOfLoadedRecords: number;
  importedRecords: number;
  duplicateRecords: number;
  uploader: string;
  status: 'Completed' | 'Restored' | 'Deleted' | 'Verified' | 'Partial Success' | 'Failed';
  versionNumber?: number;
  isActive?: boolean;
  uploadDate?: string;
  uploadTime?: string;
  fileUrl?: string;
  totalExcelRows?: number;
  validRows?: number;
  skippedRows?: number;
  duplicateRows?: number;
  expectedWrites?: number;
  successfulBatchCount?: number;
  failedBatchCount?: number;
  verificationStatus?: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED' | 'PENDING';
  verificationTime?: string;
  verificationDurationMs?: number;
  batchDetails?: BatchCommitDetail[];
  failedBatchDetails?: BatchCommitDetail[];
  missingRecordsCount?: number;
}

export interface BatchCommitDetail {
  batchNumber: number;
  recordsCount: number;
  startTime: string;
  finishTime: string;
  status: 'SUCCESS' | 'FAILED';
  retries: number;
  error?: string;
}

export interface UploadHistoryRecord {
  id: string;
  originalFileName: string;
  fileUrl: string;
  uploadDate: string;
  uploadTime: string;
  uploadedBy: string;
  totalRecords: number;
  totalExcelRows?: number;
  validRows?: number;
  skippedRows?: number;
  duplicateRows?: number;
  expectedWrites?: number;
  successfulBatchCount?: number;
  failedBatchCount?: number;
  verificationStatus?: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED' | 'PENDING';
  verificationTime?: string;
  verificationDurationMs?: number;
  batchDetails?: BatchCommitDetail[];
  failedBatchDetails?: BatchCommitDetail[];
  missingRecordsCount?: number;
  importedRecordCount?: number;
  fileSize: string;
  uploadStatus: 'Uploading' | 'Completed' | 'Failed';
  versionNumber: number;
  activeVersion: boolean;
  completionTime?: string;
  timestamp: string;
}

export interface CollectionRequest {
  id: string;
  licenseId: string;
  licenseHolderName: string;
  licenseNumber: string;
  receiverName: string;
  phoneNumber: string;
  visitDay: string;
  remarks?: string;
  status: RequestStatus;
  createdAt: string;
}

export interface Notice {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  createdBy: string;
  createdByName?: string;
  active: boolean;
  attachmentUrl?: string;
  attachmentName?: string;
}

export interface UserRole {
  id: string; // User UID
  username?: string;
  email: string;
  role: AppRole;
  displayName?: string;
  updatedAt: string;
  createdAt?: string;
  mobile?: string;
  post?: string;
  status?: 'ACTIVE' | 'SUSPENDED';
  passwordHash?: string;
  passwordVersion?: number;
  passwordLastChanged?: string;
  updatedBy?: string;
  isCustomPassword?: boolean;
  mustChangePassword?: boolean;
  assignedTasks?: string[];
  temporaryPassword?: string;
  customStoredPassword?: string;
}

export interface OfficeSettings {
  officeName: string;
  officeAddress: string;
  officeLogo?: string;
  contactNumber?: string;
  emailAddress?: string;
  websiteFooter?: string;
  homepageBanner?: string;
  searchMenuLabel?: string;
  requestMenuLabel?: string;
  contactMenuLabel?: string;
  noticesMenuLabel?: string;
  consoleSecurityPin?: string;
}

export interface SystemStats {
  totalSearchesServed: number;
}
