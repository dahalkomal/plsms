import { jsPDF } from 'jspdf';
import { write as writeStyle, utils as utilsStyle } from 'xlsx-js-style';
import { getOfficeSettings, getAllUserRoles, isLicenseDistributed } from '../dbService';
import { License, CollectionRequest, UploadLedger } from '../types';

export interface ExportReportOptions {
  reportTitle: string;
  sheetName?: string;
  records: any[];
  reportType?: string;
  dateRangeStr?: string;
  generatedBy?: string;
  onProgress?: (percent: number) => void;
}

export interface IntegratedExportOptions {
  selectedKeys: string[];
  recordsMap: Record<string, any[]>;
  dateRangeStr?: string;
  generatedBy?: string;
  endBSStr?: string;
  onProgressStatus?: (status: string) => void;
}

/**
 * Utility to process large arrays asynchronously in micro-chunks 
 * to prevent browser UI freezing for 20,000 - 500,000+ records.
 */
export async function processChunked<T, R>(
  items: T[],
  chunkSize: number,
  processor: (item: T, index: number) => R,
  onProgress?: (percent: number) => void
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const total = items.length;
  if (total === 0) return [];

  for (let i = 0; i < total; i += chunkSize) {
    const end = Math.min(i + chunkSize, total);
    for (let j = i; j < end; j++) {
      results[j] = processor(items[j], j);
    }
    if (onProgress && total > 0) {
      onProgress(Math.round((end / total) * 100));
    }
    // Yield to main thread
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return results;
}

/**
 * Fetch Office Branding (Name & Address) for reports
 */
async function getReportOfficeInfo() {
  let officeName = "Transport Management Office, Driving License";
  let officeAddress = "ITAHARI, SUNSARI, NEPAL";

  try {
    const settings = await getOfficeSettings();
    if (settings?.officeName) {
      officeName = settings.officeName.toUpperCase();
      if (!officeName.includes("DRIVING LICENSE")) {
        officeName += ", DRIVING LICENSE";
      }
    }
    if (settings?.officeAddress) {
      officeAddress = settings.officeAddress.toUpperCase();
    }
  } catch (err) {
    console.error("Failed to load office settings for export:", err);
  }

  return { officeName, officeAddress };
}

/**
 * Helper to ensure null, undefined, missing, or "N/A" values export as blank ("")
 */
function cleanVal(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val).trim();
  const upper = str.toUpperCase();
  if (
    str === '' ||
    upper === 'N/A' ||
    upper === 'NULL' ||
    upper === 'UNDEFINED' ||
    str === '--' ||
    str === '---'
  ) {
    return '';
  }
  return str;
}

/**
 * Convert Date/Time string to AD/BS string (returns "" if missing or invalid)
 */
function formatDateBS(dateStr?: string): string {
  if (!dateStr) return '';
  const clean = String(dateStr).trim();
  if (!clean || clean.toUpperCase() === 'N/A') return '';
  try {
    const d = new Date(clean);
    if (isNaN(d.getTime())) return clean.toUpperCase() === 'N/A' ? '' : clean;
    return d.toISOString().split('T')[0];
  } catch {
    return clean.toUpperCase() === 'N/A' ? '' : clean;
  }
}

/**
 * Check if a string is an email address or technical UID/identifier
 */
function isEmailOrTechId(val: string): boolean {
  if (!val) return false;
  const s = val.trim();
  if (s.includes('@')) return true;
  if (/^[a-zA-Z0-9_-]{20,36}$/.test(s) && !s.includes(' ')) return true;
  return false;
}

/**
 * Resolves a staff email/UID identifier into the staff member's FULL NAME.
 * If no matching staff profile is found, converts email username to clean uppercase name.
 * NEVER exports raw email addresses or technical IDs.
 */
function resolveStaffName(identifier: any, userRolesList: any[] = []): string {
  if (identifier === null || identifier === undefined) return '';
  const cleanId = String(identifier).trim();
  if (!cleanId || cleanId.toUpperCase() === 'N/A' || cleanId === 'system@plsms.gov.bd' || cleanId === '--' || cleanId === '---') return '';

  const emailLower = cleanId.toLowerCase();

  // Known static fallback profiles for core staff emails
  if (emailLower === 'dahalkomal@gmail.com' || emailLower === 'komaldahal@gmail.com') {
    return 'KOMAL DAHAL';
  }
  if (emailLower === 'dahalutkrishta@gmail.com') return 'UTKRISHTA DAHAL';
  if (emailLower === 'sitanshudahala@gmail.com') return 'SITANSHU DAHAL';
  if (emailLower === 'tmoitahari@gmail.com') return 'OFFICE ADMIN';

  // Lookup in staff database (userRolesList)
  if (Array.isArray(userRolesList) && userRolesList.length > 0) {
    const foundUser = userRolesList.find(u => {
      const uEmail = (u.email || '').toLowerCase().trim();
      const uId = (u.id || '').toLowerCase().trim();
      if (uEmail && uEmail === emailLower) return true;
      if (uId && uId === emailLower) return true;
      if (uEmail && emailLower.includes('@') && uEmail.split('@')[0] === emailLower.split('@')[0]) return true;
      return false;
    });

    if (foundUser && (foundUser.displayName || foundUser.fullName || foundUser.name)) {
      const dispName = String(foundUser.displayName || foundUser.fullName || foundUser.name).trim();
      if (dispName && !isEmailOrTechId(dispName) && dispName.toUpperCase() !== 'N/A') {
        return dispName.toUpperCase();
      }
    }
  }

  // If cleanId is already a readable full name (not an email or technical ID)
  if (!isEmailOrTechId(cleanId)) {
    const upper = cleanId.toUpperCase();
    if (!['AVAILABLE', 'DISTRIBUTED', 'MISSING', 'PENDING', 'FOUND', 'COMPLETED', 'RESTORED', 'DELETED', 'VERIFIED'].includes(upper)) {
      return upper;
    }
  }

  // Fallback for email: convert email username (e.g. komal.dahal@gmail.com -> KOMAL DAHAL)
  if (emailLower.includes('@')) {
    const username = emailLower.split('@')[0];
    const parts = username.replace(/[._-]/g, ' ').trim().split(/\s+/);
    const formatted = parts.map(p => p.toUpperCase()).join(' ');
    if (formatted.length > 0) {
      return formatted;
    }
  }

  return '';
}

/**
 * Helper to format SUBMITTED DOC. field according to PLSMS specifications
 */
function formatSubmittedDoc(rec: any): string {
  if (!rec) return '---';

  const recName = (rec.recommendedStaffName || rec.recommended_staff_name || '').trim();

  // 1. Direct single property string (e.g. rec.submittedDoc or rec.submitted_doc or rec.submittedDocument)
  const direct = rec.submittedDoc || rec.submitted_doc || rec.submittedDocument;
  if (typeof direct === 'string' && direct.trim()) {
    const trimmed = direct.trim();
    if (trimmed === 'Office Staff Recommendation' || trimmed === 'Staff Recommendation') {
      return recName ? `Recom. By: ${recName}` : 'Office Staff Recommendation';
    }
    return trimmed;
  }

  // 2. Array or string in submittedDocs / submittedDocuments / submittedDocList
  const docs = rec.submittedDocs || rec.submittedDocuments || rec.submittedDocList;
  if (typeof docs === 'string' && docs.trim()) {
    const trimmed = docs.trim();
    if (trimmed === 'Office Staff Recommendation' || trimmed === 'Staff Recommendation') {
      return recName ? `Recom. By: ${recName}` : 'Office Staff Recommendation';
    }
    return trimmed;
  }

  if (Array.isArray(docs) && docs.length > 0) {
    const formatted = docs.map((doc: any) => {
      const dStr = String(doc).trim();
      if (dStr === 'Office Staff Recommendation' || dStr === 'Staff Recommendation') {
        return recName ? `Recom. By: ${recName}` : 'Office Staff Recommendation';
      }
      if (dStr === 'Other' && rec.submittedDocsOther) {
        return `Other (${rec.submittedDocsOther})`;
      }
      return dStr;
    }).filter(Boolean).join(', ');
    if (formatted) return formatted;
  }

  if (recName) {
    return `Recom. By: ${recName}`;
  }

  return '---';
}

/**
 * Helper to format STATUS field according to PLSMS specifications
 */
function formatStatus(rec: any): string {
  if (!rec) return 'NOT-DISTRIBUTED';
  const s = rec.status;
  if (!s) return 'NOT-DISTRIBUTED';

  const str = String(s).trim();
  if (!str) return 'NOT-DISTRIBUTED';

  const upper = str.toUpperCase();
  if (upper === 'NOT_DISTRIBUTED' || upper === 'NOT DISTRIBUTED') return 'NOT-DISTRIBUTED';
  return upper;
}

/**
 * Transforms report Excel sheets by renaming any existing "VISITING DAY" or "VISITING DATE" header to "DEPARTMENT".
 * Applies case-insensitive and trimmed matching strictly to "VISITING DAY" and "VISITING DATE".
 * Leaves sheets without "VISITING DAY" or "VISITING DATE" completely untouched.
 */
function sanitizeReportWorkbookHeaders(wb: any): void {
  if (!wb || !wb.SheetNames || !wb.Sheets) return;

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    for (const cellKey of Object.keys(ws)) {
      if (cellKey.startsWith('!')) continue;

      const cell = ws[cellKey];
      if (cell && typeof cell.v === 'string') {
        const trimmedVal = cell.v.trim();
        const upper = trimmedVal.toUpperCase();
        if (upper === 'VISITING DAY' || upper === 'VISITING DATE') {
          if (trimmedVal === 'Visiting Day' || trimmedVal === 'Visiting Date') {
            cell.v = 'Department';
            if (cell.w !== undefined) cell.w = 'Department';
          } else if (trimmedVal === 'visiting day' || trimmedVal === 'visiting date') {
            cell.v = 'department';
            if (cell.w !== undefined) cell.w = 'department';
          } else {
            cell.v = 'DEPARTMENT';
            if (cell.w !== undefined) cell.w = 'DEPARTMENT';
          }
        }
      }
    }
  }
}

/**
 * EXCEL EXPORT (Official Sample Template Format using xlsx-js-style)
 */
export async function exportReportToExcel(options: ExportReportOptions): Promise<void> {
  const { officeName, officeAddress } = await getReportOfficeInfo();
  const userRolesList = await getAllUserRoles().catch(() => []);
  const title = (options.reportTitle || "DRIVING LICENSE LEDGER REPORT").toUpperCase();
  const sheetName = options.sheetName || "PLSMS Report";
  const dateStr = options.dateRangeStr || `Generated: ${new Date().toLocaleDateString('en-GB')}`;

  const isRequests = options.reportType === 'requests' || (options.records.length > 0 && ('licenseHolderName' in options.records[0] || ('receiverName' in options.records[0] && !('applicantId' in options.records[0]))));
  const isUploadHistory = options.reportType === 'upload_history' || (options.records.length > 0 && ('filename' in options.records[0] || 'recordCount' in options.records[0]));

  let headers: string[] = [];
  if (isRequests) {
    headers = [
      "S.N.",
      "REQUEST ID",
      "LICENSE HOLDER",
      "LICENSE NUMBER",
      "RECEIVER NAME",
      "CONTACT PHONE",
      "PICKUP DAY",
      "REMARKS",
      "STATUS",
      "CREATED AT"
    ];
  } else if (isUploadHistory) {
    headers = [
      "S.N.",
      "LEDGER ID",
      "FILENAME",
      "RECORD COUNT",
      "UPLOAD DATE",
      "UPLOAD TIME",
      "UPLOADED BY",
      "VERSION",
      "STATUS"
    ];
  } else {
    headers = [
      "S.N.",
      "APPLICANT ID",
      "FULL NAME",
      "LICENSE NUMBER",
      "CATEGORY",
      "OLD CODE",
      "NEW CODE",
      "DEPARTMENT",
      "RECEIVED BY",
      "DISTRIBUTED DATE",
      "DISTRIBUTED BY",
      "SUBMITTED DOC.",
      "STATUS"
    ];
  }

  // Build Header Block matching Official Sample Excel Template
  const colCount = headers.length;
  const emptyCols = new Array(colCount - 1).fill("");
  const wsData: any[][] = [
    [officeName, ...emptyCols],
    [officeAddress, ...emptyCols],
    [`OFFICIAL REPORT: ${title} | ${dateStr}`, ...emptyCols],
    ["", ...emptyCols],
    headers
  ];

  // Process data rows in async chunks for maximum enterprise performance
  const processedRows = await processChunked(
    options.records,
    5000,
    (rec, idx) => {
      const sn = idx + 1;
      if (isRequests) {
        return [
          sn,
          cleanVal(rec.id),
          cleanVal(rec.licenseHolderName || rec.fullName),
          cleanVal(rec.licenseNumber),
          resolveStaffName(rec.receiverName, userRolesList) || cleanVal(rec.receiverName),
          cleanVal(rec.phoneNumber),
          cleanVal(rec.visitDay),
          cleanVal(rec.remarks),
          rec.status ? String(rec.status).toUpperCase() : 'PENDING',
          formatDateBS(rec.createdAt)
        ];
      } else if (isUploadHistory) {
        return [
          sn,
          cleanVal(rec.id),
          cleanVal(rec.filename || rec.fileName || rec.originalFileName),
          rec.recordCount ?? rec.totalRecords ?? rec.noOfLoadedRecords ?? '',
          cleanVal(rec.uploadDate),
          cleanVal(rec.uploadTime),
          resolveStaffName(rec.uploadedBy || rec.uploader, userRolesList),
          rec.versionNumber || '',
          cleanVal(rec.status || rec.uploadStatus || 'Verified')
        ];
      } else {
        const isDistributed = rec.status === 'distributed' || rec.distributed === true || rec.status === 'found';
        const applicantId = cleanVal(rec.applicantId || rec.applicantNo || rec.appId);
        const fullName = cleanVal(rec.fullName || rec.licenseHolderName || rec.name);
        const licenseNumber = cleanVal(rec.licenseNumber || rec.licenseNo || rec.dlNo);
        const category = cleanVal(rec.category || rec.class);
        const oldCode = cleanVal(rec.oldCode || rec.old_code);
        const newCode = cleanVal(rec.newCode || rec.new_code);
        const visitingDate = cleanVal(rec.contactDepartment || rec.officeVisitDay || rec.visitingDate || rec.visitDay);
        const receivedBy = resolveStaffName(rec.receivedBy || rec.receiverName || rec.collectedBy, userRolesList) || cleanVal(rec.receivedBy || rec.receiverName || rec.collectedBy);
        const distributedDate = isDistributed ? cleanVal(rec.distributedDate || formatDateBS(rec.updatedAt || rec.distributionDate)) : '';
        const distributedBy = isDistributed ? resolveStaffName(rec.distributedByStaffName || rec.distributedBy || rec.updatedBy, userRolesList) : '';
        const submittedDoc = formatSubmittedDoc(rec);
        const statusVal = formatStatus(rec);

        return [
          sn,
          applicantId,
          fullName,
          licenseNumber,
          category,
          oldCode,
          newCode,
          visitingDate,
          receivedBy,
          distributedDate,
          distributedBy,
          submittedDoc,
          statusVal
        ];
      }
    },
    options.onProgress
  );

  wsData.push(...processedRows);

  // Add Summary Total Row
  wsData.push([
    `TOTAL RECORDS: ${options.records.length}`, ...emptyCols
  ]);

  // Create workbook and worksheet
  const wb = utilsStyle.book_new();
  const ws = utilsStyle.aoa_to_sheet(wsData);

  const totalRowIndex = wsData.length - 1;
  const maxColIdx = colCount - 1;
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: maxColIdx } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: maxColIdx } },
    { s: { r: 2, c: 0 }, e: { r: 2, c: maxColIdx } },
    { s: { r: totalRowIndex, c: 0 }, e: { r: totalRowIndex, c: maxColIdx } }
  ];

  // Styling Header Rows
  if (ws['A1']) {
    ws['A1'].s = {
      font: { bold: true, color: { rgb: "DA251D" }, name: "Arial", sz: 13 },
      alignment: { horizontal: "center", vertical: "center" }
    };
  }
  if (ws['A2']) {
    ws['A2'].s = {
      font: { bold: true, color: { rgb: "DA251D" }, name: "Arial", sz: 10.5 },
      alignment: { horizontal: "center", vertical: "center" }
    };
  }
  if (ws['A3']) {
    ws['A3'].s = {
      font: { bold: true, color: { rgb: "1E293B" }, name: "Arial", sz: 9.5 },
      fill: { fgColor: { rgb: "F1F5F9" } },
      alignment: { horizontal: "center", vertical: "center" }
    };
  }

  // Column Letters
  const colLetters = Array.from({ length: colCount }, (_, i) => String.fromCharCode(65 + i));
  colLetters.forEach((col) => {
    const cellRef = `${col}5`;
    if (ws[cellRef]) {
      ws[cellRef].s = {
        font: { bold: true, color: { rgb: "DA251D" }, name: "Arial", sz: 9.5 },
        fill: { fgColor: { rgb: "FEE2E2" } },
        alignment: { horizontal: "center", vertical: "center" },
        border: {
          top: { style: "thin", color: { rgb: "EF4444" } },
          bottom: { style: "thin", color: { rgb: "EF4444" } },
          left: { style: "thin", color: { rgb: "FCA5A5" } },
          right: { style: "thin", color: { rgb: "FCA5A5" } }
        }
      };
    }
  });

  // Style Data Rows
  for (let r = 5; r < 5 + processedRows.length; r++) {
    const isOdd = r % 2 === 1;
    const bg = isOdd ? "F8FAFC" : "FFFFFF";

    colLetters.forEach((col, cIdx) => {
      const cellRef = `${col}${r + 1}`;
      if (ws[cellRef]) {
        ws[cellRef].s = {
          font: { name: "Arial", sz: 9, color: { rgb: "1E293B" } },
          fill: { fgColor: { rgb: bg } },
          alignment: {
            horizontal: cIdx === 2 ? "left" : "center",
            vertical: "center"
          },
          border: {
            top: { style: "thin", color: { rgb: "E2E8F0" } },
            bottom: { style: "thin", color: { rgb: "E2E8F0" } },
            left: { style: "thin", color: { rgb: "E2E8F0" } },
            right: { style: "thin", color: { rgb: "E2E8F0" } }
          }
        };
      }
    });
  }

  // Style Total Row
  const totalCellRef = `A${totalRowIndex + 1}`;
  if (ws[totalCellRef]) {
    ws[totalCellRef].s = {
      font: { bold: true, color: { rgb: "0F172A" }, name: "Arial", sz: 10 },
      fill: { fgColor: { rgb: "E2E8F0" } },
      alignment: { horizontal: "left", vertical: "center" }
    };
  }

  // Column Widths
  if (isRequests) {
    ws['!cols'] = [
      { wch: 8 }, { wch: 18 }, { wch: 28 }, { wch: 22 }, { wch: 24 },
      { wch: 18 }, { wch: 16 }, { wch: 24 }, { wch: 14 }, { wch: 16 }
    ];
  } else if (isUploadHistory) {
    ws['!cols'] = [
      { wch: 8 }, { wch: 20 }, { wch: 32 }, { wch: 16 }, { wch: 16 },
      { wch: 16 }, { wch: 22 }, { wch: 12 }, { wch: 14 }
    ];
  } else {
    ws['!cols'] = [
      { wch: 8 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
      { wch: 22 }, { wch: 18 }
    ];
  }

  ws['!views'] = [
    { state: 'frozen', ySplit: 5, xSplit: 0, topLeftCell: 'A6', activePane: 'bottomLeft' }
  ];

  utilsStyle.book_append_sheet(wb, ws, sheetName.substring(0, 31));

  sanitizeReportWorkbookHeaders(wb);
  const wbout = writeStyle(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const fileName = `PLSMS_${title.replace(/[\s\/]+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * CSV EXPORT (Standard Fast CSV Format)
 */
export async function exportReportToCsv(options: ExportReportOptions): Promise<void> {
  const title = (options.reportTitle || "REPORT").toUpperCase();
  const records = options.records || [];
  const userRolesList = await getAllUserRoles().catch(() => []);

  const isRequests = options.reportType === 'requests' || (records[0] && ('licenseHolderName' in records[0] || ('receiverName' in records[0] && !('applicantId' in records[0]))));
  const isUploadHistory = options.reportType === 'upload_history' || (records[0] && ('filename' in records[0] || 'recordCount' in records[0]));

  let defaultHeaders: string[] = [];
  if (isRequests) {
    defaultHeaders = ["SN", "RequestId", "LicenseHolder", "LicenseNumber", "ReceiverName", "PhoneNumber", "PickupDay", "Remarks", "Status", "CreatedAt"];
  } else if (isUploadHistory) {
    defaultHeaders = ["SN", "LedgerId", "Filename", "RecordCount", "UploadDate", "UploadTime", "UploadedBy", "Version", "Status"];
  } else {
    defaultHeaders = ["SN", "ApplicantId", "FullName", "LicenseNumber", "Category", "OldCode", "NewCode", "Department", "ReceivedBy", "DistributedDate", "DistributedBy", "SubmittedDoc", "Status"];
  }

  let reportRows: any[] = [];
  if (isRequests) {
    reportRows = records.map((req, idx) => ({
      SN: idx + 1,
      RequestId: cleanVal(req.id),
      LicenseHolder: cleanVal(req.licenseHolderName || req.fullName),
      LicenseNumber: cleanVal(req.licenseNumber),
      ReceiverName: resolveStaffName(req.receiverName, userRolesList) || cleanVal(req.receiverName),
      PhoneNumber: cleanVal(req.phoneNumber),
      PickupDay: cleanVal(req.visitDay),
      Remarks: cleanVal(req.remarks),
      Status: req.status ? String(req.status).toUpperCase() : 'PENDING',
      CreatedAt: formatDateBS(req.createdAt)
    }));
  } else if (isUploadHistory) {
    reportRows = records.map((ledger, idx) => ({
      SN: idx + 1,
      LedgerId: cleanVal(ledger.id),
      Filename: cleanVal(ledger.filename || ledger.fileName || ledger.originalFileName),
      RecordCount: ledger.recordCount ?? ledger.totalRecords ?? ledger.noOfLoadedRecords ?? '',
      UploadDate: cleanVal(ledger.uploadDate),
      UploadTime: cleanVal(ledger.uploadTime),
      UploadedBy: resolveStaffName(ledger.uploadedBy || ledger.uploader, userRolesList),
      Version: ledger.versionNumber || '',
      Status: cleanVal(ledger.status || ledger.uploadStatus || 'Verified')
    }));
  } else {
    reportRows = records.map((l, idx) => {
      const isDist = l.status === 'distributed' || l.distributed === true || l.status === 'found';
      return {
        SN: idx + 1,
        ApplicantId: cleanVal(l.applicantId || l.applicantNo || l.appId),
        FullName: cleanVal(l.fullName || l.licenseHolderName || l.name),
        LicenseNumber: cleanVal(l.licenseNumber || l.licenseNo || l.dlNo),
        Category: cleanVal(l.category || l.class),
        OldCode: cleanVal(l.oldCode || l.old_code),
        NewCode: cleanVal(l.newCode || l.new_code),
        VisitingDate: cleanVal(l.contactDepartment || l.officeVisitDay || l.visitingDate || l.visitDay),
        ReceivedBy: resolveStaffName(l.receivedBy || l.receiverName || l.collectedBy, userRolesList) || cleanVal(l.receivedBy || l.receiverName || l.collectedBy),
        DistributedDate: isDist ? cleanVal(l.distributedDate || formatDateBS(l.updatedAt || l.distributionDate)) : '',
        DistributedBy: isDist ? resolveStaffName(l.distributedByStaffName || l.distributedBy || l.updatedBy, userRolesList) : '',
        SubmittedDoc: formatSubmittedDoc(l),
        Status: formatStatus(l)
      };
    });
  }

  const headers = reportRows.length > 0 ? Object.keys(reportRows[0]) : defaultHeaders;
  const csvLines = [
    headers.join(','),
    ...reportRows.map(row => headers.map(fieldName => {
      const val = row[fieldName] ?? '';
      return val === '' ? '' : JSON.stringify(val);
    }).join(','))
  ];

  const blob = new Blob([csvLines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  const fileName = `PLSMS_${title.replace(/[\s\/]+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
  link.setAttribute("download", fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * INTEGRATED MULTI-SHEET EXCEL EXPORT (Official Sample Template Styling)
 */
export async function exportIntegratedReportToExcel(options: IntegratedExportOptions): Promise<void> {
  const { selectedKeys, recordsMap, dateRangeStr, endBSStr, onProgressStatus } = options;

  if (!selectedKeys || selectedKeys.length === 0) {
    throw new Error("Please select at least one report section.");
  }

  onProgressStatus?.("Generating Workbook...");
  await new Promise(r => setTimeout(r, 50));

  const { officeName, officeAddress } = await getReportOfficeInfo();
  const userRolesList = await getAllUserRoles().catch(() => []);
  const dateHeaderStr = dateRangeStr || `Generated: ${new Date().toLocaleDateString('en-GB')}`;

  const wb = utilsStyle.book_new();

  const reportConfigs: Record<string, { sheetName: string; title: string; isRequest?: boolean }> = {
    totalSmartCards: { sheetName: 'TOTAL SMART CARDS', title: 'TOTAL SMART CARDS LEDGER REPORT' },
    distributedCards: { sheetName: 'DISTRIBUTED CARDS', title: 'DISTRIBUTED SMART CARDS REPORT' },
    notDistributedCards: { sheetName: 'NOT-DISTRIBUTED CARDS', title: 'NOT-DISTRIBUTED CARDS REPORT' },
    missingCards: { sheetName: 'MISSING CARDS', title: 'MISSING SMART CARDS REPORT' },
    foundCards: { sheetName: 'FOUND CARDS', title: 'FOUND SMART CARDS REPORT' },
    requestToReceive: { sheetName: 'REQUEST TO RECEIVE', title: 'REQUEST TO RECEIVE SCHEDULED REPORT', isRequest: true }
  };

  const licenseHeaders = [
    "S.N.",
    "APPLICANT ID",
    "FULL NAME",
    "LICENSE NUMBER",
    "CATEGORY",
    "OLD CODE",
    "NEW CODE",
    "DEPARTMENT",
    "RECEIVED BY",
    "DISTRIBUTED DATE",
    "DISTRIBUTED BY",
    "SUBMITTED DOC.",
    "STATUS"
  ];

  const requestHeaders = [
    "S.N.",
    "REQUEST ID",
    "LICENSE HOLDER",
    "LICENSE NUMBER",
    "RECEIVER NAME",
    "CONTACT PHONE",
    "PICKUP DAY",
    "REMARKS",
    "STATUS",
    "CREATED AT"
  ];

  for (const key of selectedKeys) {
    const config = reportConfigs[key] || { sheetName: key.toUpperCase(), title: `${key.toUpperCase()} REPORT` };
    const rawRecords = recordsMap[key] || [];
    const isReq = config.isRequest === true;
    const headers = isReq ? requestHeaders : licenseHeaders;
    const colCount = headers.length;
    const emptyCols = new Array(colCount - 1).fill("");

    const wsData: any[][] = [
      [officeName, ...emptyCols],
      [officeAddress, ...emptyCols],
      [`OFFICIAL REPORT: ${config.title} | ${dateHeaderStr}`, ...emptyCols],
      ["", ...emptyCols],
      headers
    ];

    let processedRows: any[][] = [];

    if (rawRecords.length === 0) {
      // Create empty record indicator inside template
      processedRows = [
        ["No Records Found", ...emptyCols]
      ];
    } else {
      processedRows = await processChunked(
        rawRecords,
        5000,
        (rec, idx) => {
          const sn = idx + 1;
          if (isReq) {
            return [
              sn,
              cleanVal(rec.id),
              cleanVal(rec.licenseHolderName || rec.fullName),
              cleanVal(rec.licenseNumber),
              resolveStaffName(rec.receiverName, userRolesList) || cleanVal(rec.receiverName),
              cleanVal(rec.phoneNumber),
              cleanVal(rec.visitDay),
              cleanVal(rec.remarks),
              rec.status ? String(rec.status).toUpperCase() : 'PENDING',
              formatDateBS(rec.createdAt)
            ];
          } else {
            const isDist = rec.status === 'distributed' || rec.distributed === true || rec.status === 'found' || isLicenseDistributed(rec);
            const submittedDoc = formatSubmittedDoc(rec);
            const statusVal = formatStatus(rec);

            return [
              sn,
              cleanVal(rec.applicantId || rec.applicantNo || rec.appId),
              cleanVal(rec.fullName || rec.licenseHolderName || rec.name),
              cleanVal(rec.licenseNumber || rec.licenseNo || rec.dlNo),
              cleanVal(rec.category || rec.class),
              cleanVal(rec.oldCode || rec.old_code),
              cleanVal(rec.newCode || rec.new_code),
              cleanVal(rec.contactDepartment || rec.officeVisitDay || rec.visitingDate || rec.visitDay),
              resolveStaffName(rec.receivedBy || rec.receiverName || rec.collectedBy, userRolesList) || cleanVal(rec.receivedBy || rec.receiverName || rec.collectedBy),
              isDist ? cleanVal(rec.distributedDate || formatDateBS(rec.updatedAt || rec.distributionDate)) : '',
              isDist ? resolveStaffName(rec.distributedByStaffName || rec.distributedBy || rec.updatedBy, userRolesList) : '',
              submittedDoc,
              statusVal
            ];
          }
        }
      );
    }

    wsData.push(...processedRows);
    wsData.push([`TOTAL RECORDS: ${rawRecords.length}`, ...emptyCols]);

    onProgressStatus?.("Formatting Excel...");
    await new Promise(r => setTimeout(r, 20));

    const ws = utilsStyle.aoa_to_sheet(wsData);
    const totalRowIndex = wsData.length - 1;

    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: colCount - 1 } },
      { s: { r: 1, c: 0 }, e: { r: 1, c: colCount - 1 } },
      { s: { r: 2, c: 0 }, e: { r: 2, c: colCount - 1 } },
      { s: { r: totalRowIndex, c: 0 }, e: { r: totalRowIndex, c: colCount - 1 } }
    ];

    if (rawRecords.length === 0) {
      ws['!merges'].push({ s: { r: 5, c: 0 }, e: { r: 5, c: colCount - 1 } });
    }

    if (ws['A1']) {
      ws['A1'].s = {
        font: { bold: true, color: { rgb: "DA251D" }, name: "Arial", sz: 13 },
        alignment: { horizontal: "center", vertical: "center" }
      };
    }
    if (ws['A2']) {
      ws['A2'].s = {
        font: { bold: true, color: { rgb: "DA251D" }, name: "Arial", sz: 10.5 },
        alignment: { horizontal: "center", vertical: "center" }
      };
    }
    if (ws['A3']) {
      ws['A3'].s = {
        font: { bold: true, color: { rgb: "1E293B" }, name: "Arial", sz: 9.5 },
        fill: { fgColor: { rgb: "F1F5F9" } },
        alignment: { horizontal: "center", vertical: "center" }
      };
    }

    const colLetters = Array.from({ length: colCount }, (_, i) => String.fromCharCode(65 + i));

    colLetters.forEach((col) => {
      const cellRef = `${col}5`;
      if (ws[cellRef]) {
        ws[cellRef].s = {
          font: { bold: true, color: { rgb: "DA251D" }, name: "Arial", sz: 9.5 },
          fill: { fgColor: { rgb: "FEE2E2" } },
          alignment: { horizontal: "center", vertical: "center" },
          border: {
            top: { style: "thin", color: { rgb: "EF4444" } },
            bottom: { style: "thin", color: { rgb: "EF4444" } },
            left: { style: "thin", color: { rgb: "FCA5A5" } },
            right: { style: "thin", color: { rgb: "FCA5A5" } }
          }
        };
      }
    });

    if (rawRecords.length === 0) {
      if (ws['A6']) {
        ws['A6'].s = {
          font: { italic: true, color: { rgb: "64748B" }, name: "Arial", sz: 10 },
          fill: { fgColor: { rgb: "F8FAFC" } },
          alignment: { horizontal: "center", vertical: "center" },
          border: {
            top: { style: "thin", color: { rgb: "E2E8F0" } },
            bottom: { style: "thin", color: { rgb: "E2E8F0" } },
            left: { style: "thin", color: { rgb: "E2E8F0" } },
            right: { style: "thin", color: { rgb: "E2E8F0" } }
          }
        };
      }
    } else {
      for (let r = 5; r < 5 + processedRows.length; r++) {
        const isOdd = r % 2 === 1;
        const bg = isOdd ? "F8FAFC" : "FFFFFF";

        colLetters.forEach((col, cIdx) => {
          const cellRef = `${col}${r + 1}`;
          if (ws[cellRef]) {
            ws[cellRef].s = {
              font: { name: "Arial", sz: 9, color: { rgb: "1E293B" } },
              fill: { fgColor: { rgb: bg } },
              alignment: { horizontal: cIdx === 2 ? "left" : "center", vertical: "center" },
              border: {
                top: { style: "thin", color: { rgb: "E2E8F0" } },
                bottom: { style: "thin", color: { rgb: "E2E8F0" } },
                left: { style: "thin", color: { rgb: "E2E8F0" } },
                right: { style: "thin", color: { rgb: "E2E8F0" } }
              }
            };
          }
        });
      }
    }

    const totalCellRef = `A${totalRowIndex + 1}`;
    if (ws[totalCellRef]) {
      ws[totalCellRef].s = {
        font: { bold: true, color: { rgb: "0F172A" }, name: "Arial", sz: 10 },
        fill: { fgColor: { rgb: "E2E8F0" } },
        alignment: { horizontal: "left", vertical: "center" }
      };
    }

    if (isReq) {
      ws['!cols'] = [
        { wch: 8 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 22 },
        { wch: 16 }, { wch: 14 }, { wch: 24 }, { wch: 14 }, { wch: 16 }
      ];
    } else {
      ws['!cols'] = [
        { wch: 8 }, { wch: 16 }, { wch: 28 }, { wch: 22 }, { wch: 12 },
        { wch: 12 }, { wch: 12 }, { wch: 20 }, { wch: 18 }, { wch: 18 }, { wch: 18 },
        { wch: 22 }, { wch: 18 }
      ];
    }

    ws['!views'] = [{ state: 'frozen', ySplit: 5, xSplit: 0, topLeftCell: 'A6', activePane: 'bottomLeft' }];

    utilsStyle.book_append_sheet(wb, ws, config.sheetName.substring(0, 31));
  }

  onProgressStatus?.("Downloading...");
  await new Promise(r => setTimeout(r, 20));

  sanitizeReportWorkbookHeaders(wb);
  const wbout = writeStyle(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;

  const dateTag = endBSStr || new Date().toISOString().split('T')[0];
  const timeTag = `${new Date().getHours().toString().padStart(2, '0')}-${new Date().getMinutes().toString().padStart(2, '0')}`;
  link.download = `Integrated_Report_${dateTag}_${timeTag}.xlsx`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * PDF EXPORT (Official Sample PDF Template Layout with jsPDF)
 */
export async function exportReportToPdf(options: ExportReportOptions): Promise<void> {
  const { officeName, officeAddress } = await getReportOfficeInfo();
  const userRolesList = await getAllUserRoles().catch(() => []);
  const title = (options.reportTitle || "DRIVING LICENSE LEDGER REPORT").toUpperCase();
  const dateStr = options.dateRangeStr || `Generated Date: ${new Date().toLocaleDateString('en-GB')}`;

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  });

  const pageWidth = doc.internal.pageSize.getWidth(); // 297mm

  // Render Official Government Header Box on a page
  const renderPageHeader = (pageNum: number) => {
    // Outer Header Box (Red Tint & Red Border)
    doc.setFillColor(254, 242, 242);
    doc.setDrawColor(252, 165, 165);
    doc.rect(12, 10, 273, 18, 'DF');

    // Office Name (Bold Red, Centered)
    doc.setTextColor(218, 37, 29);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.text(officeName, pageWidth / 2, 17, { align: 'center' });

    // Office Address (Bold Red, Centered)
    doc.setFontSize(9.5);
    doc.text(officeAddress, pageWidth / 2, 23.5, { align: 'center' });

    // Sub-header Metadata Line
    doc.setTextColor(71, 85, 105);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    doc.text(`OFFICIAL REPORT: ${title}`, 12, 33);
    doc.setFont('helvetica', 'normal');
    doc.text(`${dateStr} | Records: ${options.records.length} | Page ${pageNum}`, pageWidth - 12, 33, { align: 'right' });

    const isRequests = options.reportType === 'requests' || (options.records.length > 0 && ('licenseHolderName' in options.records[0] || ('receiverName' in options.records[0] && !('applicantId' in options.records[0]))));
    const isUploadHistory = options.reportType === 'upload_history' || (options.records.length > 0 && ('filename' in options.records[0] || 'recordCount' in options.records[0]));

    let headers: string[] = [];
    let colWidths: number[] = [];

    if (isRequests) {
      headers = ["S.N.", "REQUEST ID", "LICENSE HOLDER", "LICENSE NUMBER", "RECEIVER", "PHONE", "VISIT DAY", "REMARKS", "STATUS", "CREATED AT"];
      colWidths = [10, 24, 42, 32, 32, 24, 20, 41, 20, 28];
    } else if (isUploadHistory) {
      headers = ["S.N.", "LEDGER ID", "FILENAME", "RECORD COUNT", "UPLOAD DATE", "UPLOAD TIME", "UPLOADED BY", "VERSION", "STATUS"];
      colWidths = [12, 28, 55, 25, 28, 28, 38, 20, 39];
    } else {
      headers = [
        "S.N.",
        "APPLICANT ID",
        "FULL NAME",
        "LICENSE NUMBER",
        "CATEGORY",
        "OLD CODE",
        "NEW CODE",
        "DEPARTMENT",
        "RECEIVED BY",
        "DISTRIBUTED DATE",
        "DISTRIBUTED BY",
        "SUBMITTED DOC.",
        "STATUS"
      ];
      colWidths = [8, 20, 34, 28, 14, 13, 13, 23, 23, 23, 23, 28, 26];
    }

    const startY = 36;
    doc.setFillColor(254, 226, 226);
    doc.setDrawColor(239, 68, 68);
    doc.rect(12, startY, 273, 9, 'DF');

    doc.setTextColor(218, 37, 29);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);

    let currentX = 12;
    headers.forEach((h, idx) => {
      const w = colWidths[idx];
      doc.text(h, currentX + (w / 2), startY + 5.8, { align: 'center' });
      currentX += w;
    });

    return { colWidths, isRequests, isUploadHistory };
  };

  let pageNum = 1;
  let headerMeta = renderPageHeader(pageNum);
  let currentY = 45;
  const rowHeight = 6.5;

  // Process data rows
  for (let idx = 0; idx < options.records.length; idx++) {
    const rec = options.records[idx];

    // Page overflow check
    if (currentY + rowHeight > 185) {
      // Footer page number
      doc.setFontSize(7);
      doc.setTextColor(100, 116, 139);
      doc.text(`Transport Management Official Registry | Page ${pageNum}`, pageWidth / 2, 202, { align: 'center' });

      doc.addPage();
      pageNum++;
      headerMeta = renderPageHeader(pageNum);
      currentY = 45;
    }

    // Zebra striping
    if (idx % 2 === 1) {
      doc.setFillColor(248, 250, 252);
      doc.rect(12, currentY, 273, rowHeight, 'F');
    }

    doc.setDrawColor(226, 232, 240);
    doc.rect(12, currentY, 273, rowHeight, 'S');

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(30, 41, 59);

    const sn = String(idx + 1);
    let rowVals: string[] = [];

    if (headerMeta.isRequests) {
      rowVals = [
        sn,
        cleanVal(rec.id),
        cleanVal(rec.licenseHolderName || rec.fullName),
        cleanVal(rec.licenseNumber),
        resolveStaffName(rec.receiverName, userRolesList) || cleanVal(rec.receiverName),
        cleanVal(rec.phoneNumber),
        cleanVal(rec.visitDay),
        cleanVal(rec.remarks),
        rec.status ? String(rec.status).toUpperCase() : 'PENDING',
        formatDateBS(rec.createdAt)
      ];
    } else if (headerMeta.isUploadHistory) {
      rowVals = [
        sn,
        cleanVal(rec.id),
        cleanVal(rec.filename || rec.fileName || rec.originalFileName),
        String(rec.recordCount ?? rec.totalRecords ?? rec.noOfLoadedRecords ?? ''),
        cleanVal(rec.uploadDate),
        cleanVal(rec.uploadTime),
        resolveStaffName(rec.uploadedBy || rec.uploader, userRolesList),
        String(rec.versionNumber || ''),
        cleanVal(rec.status || rec.uploadStatus || 'Verified')
      ];
    } else {
      const isDist = rec.status === 'distributed' || rec.distributed === true || rec.status === 'found';
      const applicantId = cleanVal(rec.applicantId || rec.applicantNo || rec.appId);
      const fullName = cleanVal(rec.fullName || rec.licenseHolderName || rec.name);
      const licenseNumber = cleanVal(rec.licenseNumber || rec.licenseNo || rec.dlNo);
      const category = cleanVal(rec.category || rec.class);
      const oldCode = cleanVal(rec.oldCode || rec.old_code);
      const newCode = cleanVal(rec.newCode || rec.new_code);
      const visitingDate = cleanVal(rec.contactDepartment || rec.officeVisitDay || rec.visitingDate || rec.visitDay);
      const receivedBy = resolveStaffName(rec.receivedBy || rec.receiverName || rec.collectedBy, userRolesList) || cleanVal(rec.receivedBy || rec.receiverName || rec.collectedBy);
      const distributedDate = isDist ? cleanVal(rec.distributedDate || formatDateBS(rec.updatedAt || rec.distributionDate)) : '';
      const distributedBy = isDist ? resolveStaffName(rec.distributedByStaffName || rec.distributedBy || rec.updatedBy, userRolesList) : '';

      rowVals = [
        sn, applicantId, fullName, licenseNumber, category,
        oldCode, newCode, visitingDate, receivedBy, distributedDate, distributedBy,
        formatSubmittedDoc(rec), formatStatus(rec)
      ];
    }

    let currentX = 12;
    rowVals.forEach((val, cIdx) => {
      const w = headerMeta.colWidths[cIdx];
      // Truncate long text to prevent overflow
      const maxChars = cIdx === 2 ? 26 : 18;
      const displayVal = val.length > maxChars ? val.substring(0, maxChars - 2) + ".." : val;

      if (cIdx === 2) {
        doc.text(displayVal, currentX + 2, currentY + 4.5);
      } else {
        doc.text(displayVal, currentX + (w / 2), currentY + 4.5, { align: 'center' });
      }
      currentX += w;
    });

    currentY += rowHeight;

    // Yield every 200 items so UI stays responsive
    if (idx % 200 === 0 && idx > 0) {
      if (options.onProgress) {
        options.onProgress(Math.round((idx / options.records.length) * 100));
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  // Authorised Signature Footer Line on last page
  if (currentY + 18 > 195) {
    doc.addPage();
    pageNum++;
    renderPageHeader(pageNum);
    currentY = 45;
  }

  const footerY = Math.max(currentY + 8, 182);
  doc.setDrawColor(100, 116, 139);
  doc.setLineDashPattern([1, 1], 0);
  doc.line(210, footerY, 275, footerY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(15, 23, 42);
  doc.text("AUTHORISED IT CONTROLLER", 242.5, footerY + 4, { align: 'center' });

  // Page Footer
  doc.setFontSize(7);
  doc.setTextColor(100, 116, 139);
  doc.text(`Transport Management Official Registry System | Total: ${options.records.length} Records | Page ${pageNum}`, pageWidth / 2, 202, { align: 'center' });

  // Save PDF
  const pdfName = `PLSMS_${title.replace(/[\s\/]+/g, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
  doc.save(pdfName);
}
