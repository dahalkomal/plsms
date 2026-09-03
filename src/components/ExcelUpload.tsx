import React, { useState, useRef, useEffect } from 'react';
import { read, utils, write } from 'xlsx';
import { write as writeStyle, utils as utilsStyle } from 'xlsx-js-style';
import { auth, db } from '../firebase';
import { writeBatch, doc } from 'firebase/firestore';
import { getLicenseById, createOrUpdateLicense, getOfficeSettings, batchWriteLicenses, isDemoModeActive, createUploadLedger, updateUploadLedger, archiveExcelToStorage, BatchWriteResult, VerificationMetrics } from '../dbService';
import { License, LicenseStatus, UploadLedger, BatchCommitDetail } from '../types';
import { registryDataStore } from '../registryDataStore';
import { downloadPdfSampleTemplate } from '../utils/pdfTemplateGenerator';
import { sanitizeExcelCell, sanitizeInputString, sanitizeErrorMessage } from '../utils/securitySanitizer';
import { Upload, FileSpreadsheet, FileText, CheckCircle, AlertTriangle, Play, HelpCircle, ArrowRight, Table, AlertCircle } from 'lucide-react';

interface ExcelUploadProps {
  onUploadSuccess: () => void;
  theme?: 'light' | 'dark';
  fullWidth?: boolean;
  title?: string;
  subtitle?: string;
  stepBadge?: string;
}

interface ParsedRow {
  applicantId?: string;
  fullName?: string;
  fatherHusbandName?: string;
  licenseNumber?: string;
  category?: string;
  department?: string;
  [key: string]: any;
}

export default function ExcelUpload({ onUploadSuccess, theme = 'dark', fullWidth = false, title, subtitle, stepBadge }: ExcelUploadProps) {
  const [file, setFile] = useState<File | null>(null);
  const [data, setData] = useState<ParsedRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [previewRows, setPreviewRows] = useState<ParsedRow[]>([]);
  
  // Duplicate strategy
  const [duplicateStrategy, setDuplicateStrategy] = useState<'skip' | 'update' | 'replace'>('skip');
  
  // Execution status
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [report, setReport] = useState<{
    total: number;
    imported: number;
    skipped: number;
    updated: number;
    errors: string[];
    ledgerFailed?: boolean;
    ledgerErrorMessage?: string;
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loading) {
      localStorage.setItem('plsms_operation_running', 'true');
    } else {
      localStorage.removeItem('plsms_operation_running');
    }
    return () => {
      localStorage.removeItem('plsms_operation_running');
    };
  }, [loading]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  const processFile = (selectedFile: File) => {
    setFile(selectedFile);
    setReport(null);
    setProgress(0);
    const reader = new FileReader();
    
    reader.onload = (e) => {
      try {
        const arrayBuffer = e.target?.result as ArrayBuffer;
        const workbook = read(arrayBuffer, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        
        // Parse sheet to 2D array of rows to locate the header row dynamically
        const rows = utils.sheet_to_json(worksheet, { header: 1, defval: "" }) as any[][];
        
        if (rows.length === 0) {
          alert("Selected document appears to be empty.");
          return;
        }

        // Search first 10 rows to locate the row that contains actual table headers
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
          return;
        }

        // Construct objects from the data rows
        const json: any[] = [];
        for (let i = headerIndex + 1; i < rows.length; i++) {
          const row = rows[i];
          if (!row || row.length === 0) continue;
          const isEmpty = row.every(cell => cell === undefined || cell === null || String(cell).trim() === "");
          if (isEmpty) continue;

          const obj: Record<string, any> = {};
          cols.forEach((col, colIdx) => {
            const rawVal = row[colIdx] !== undefined ? row[colIdx] : "";
            obj[col] = typeof rawVal === 'string' ? sanitizeExcelCell(rawVal) : rawVal;
          });
          json.push(obj);
        }

        setHeaders(cols);

        // Auto mapping matcher
        const initialMapping: Record<string, string> = {};
        cols.forEach(col => {
          const norm = col.toLowerCase().replace(/[\s_\-\/\.]/g, '');
          if (norm === 'sn' || norm === 'sno' || norm === 'serial' || norm === 'sn.' || norm === 's.n.' || norm === 's_n') {
            initialMapping['sn'] = col;
          } else if (norm.includes('applicantid') || norm.includes('applicantno') || norm === 'appid' || norm === 'applicant_id' || norm === 'id' || norm.includes('app') || norm.includes('applicant')) {
            initialMapping['applicantId'] = col;
          } else if (norm.includes('fullname') || norm === 'name' || norm === 'full_name' || (norm.includes('name') && !norm.includes('father') && !norm.includes('husband') && !norm.includes('fh'))) {
            initialMapping['fullName'] = col;
          } else if (norm.includes('licensenumber') || norm.includes('licenseno') || norm === 'dlno' || norm === 'license' || norm === 'licenseno' || norm === 'licenseno.' || norm.includes('license') || norm.includes('dl')) {
            initialMapping['licenseNumber'] = col;
          } else if (norm.includes('category') || norm === 'class' || norm === 'cat' || norm.includes('cat')) {
            initialMapping['category'] = col;
          } else if (norm.includes('oldcode') || norm.includes('old') || norm === 'old_code') {
            initialMapping['oldCode'] = col;
          } else if (norm.includes('newcode') || norm.includes('new') || norm === 'new_code') {
            initialMapping['newCode'] = col;
          } else if (
            norm.includes('department') || 
            norm.includes('departmen') || 
            norm.includes('departmant') ||
            norm.includes('dept') ||
            norm.includes('ontactsection') ||
            norm.includes('contactsection') ||
            norm.includes('contactsec') ||
            norm.includes('ontactsec') ||
            norm.includes('distributionday') ||
            norm.includes('distday') ||
            norm.includes('distributiondate') ||
            norm.includes('distdate') ||
            norm.includes('visitingdate') ||
            norm.includes('visitingday') ||
            norm.includes('section') ||
            norm.includes('ontact') ||
            norm.includes('contact')
          ) {
            initialMapping['department'] = col;
          } else if (norm.includes('received') || norm.includes('receiver') || norm.includes('receivedby') || norm === 'received_by') {
            initialMapping['receivedBy'] = col;
          } else if (norm.includes('distributeddate') || norm.includes('distdate') || norm.includes('distributed_date')) {
            initialMapping['distributedDate'] = col;
          } else if (norm.includes('distributedby') || norm.includes('distby') || norm.includes('distributed_by')) {
            initialMapping['distributedBy'] = col;
          } else if (norm === 'status' || norm.includes('status') || norm.includes('currentstatus') || norm === 'state') {
            initialMapping['status'] = col;
          }
        });

        // Set fallbacks if not matched
        const requiredKeys = ['applicantId', 'fullName', 'licenseNumber'];
        requiredKeys.forEach(req => {
          if (!initialMapping[req]) {
            const found = cols.find(c => c.toLowerCase().includes(req.toLowerCase()));
            if (found) initialMapping[req] = found;
          }
        });

        // Fallback matching for department / contact section / distribution date / distribution day
        if (!initialMapping['department']) {
          const deptFound = cols.find(c => {
            const n = c.toLowerCase().replace(/[\s_\-\/\.]/g, '');
            return (
              n.includes('department') ||
              n.includes('departmant') ||
              n.includes('departmen') ||
              n.includes('dept') ||
              n.includes('ontact') ||
              n.includes('contact') ||
              n.includes('section') ||
              n.includes('distributionday') ||
              n.includes('distday') ||
              n.includes('distributiondate') ||
              n.includes('distdate') ||
              n.includes('visiting')
            );
          });
          if (deptFound) initialMapping['department'] = deptFound;
        }

        setColumnMapping(initialMapping);
        setData(json);
        setPreviewRows(json.slice(0, 5));
      } catch (err) {
        alert("Error parsing spreadsheets. Please utilize pristine CSV or XLSX headers: " + err);
      }
    };

    reader.readAsArrayBuffer(selectedFile);
  };

  const handleMapChange = (targetKey: string, sourceHeader: string) => {
    setColumnMapping(prev => ({ ...prev, [targetKey]: sourceHeader }));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      processFile(files[0]);
    }
  };

  const downloadTemplate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
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
      console.error("Failed to fetch office settings for template download:", err);
    }

    const headersList = [
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
      "DISTRIBUTED BY"
    ];

    // Build worksheet data with 11 columns matching Picture 1
    const wsData = [
      [officeName, "", "", "", "", "", "", "", "", "", ""],
      [officeAddress, "", "", "", "", "", "", "", "", "", ""],
      headersList,
      ["", "", "", "", "", "", "", "", "", "", ""],
      ["", "", "", "", "", "", "", "", "", "", ""],
      ["", "", "", "", "", "", "", "", "", "", ""]
    ];

    // Create a new workbook and convert data to a worksheet using styled utils
    const wb = utilsStyle.book_new();
    const ws = utilsStyle.aoa_to_sheet(wsData);

    // Apply merges across all 11 columns (columns A to K, indexes 0 to 10)
    ws['!merges'] = [
      { s: { r: 0, c: 0 }, e: { r: 0, c: 10 } }, // Merge row 1, cols A-K
      { s: { r: 1, c: 0 }, e: { r: 1, c: 10 } }  // Merge row 2, cols A-K
    ];

    // Set styling for Office Name (A1)
    if (ws['A1']) {
      ws['A1'].s = {
        font: {
          bold: true,
          color: { rgb: "DA251D" }, // Red font color
          name: "Arial",
          sz: 13
        },
        alignment: {
          horizontal: "center",
          vertical: "center"
        }
      };
    }

    // Set styling for Office Address (A2)
    if (ws['A2']) {
      ws['A2'].s = {
        font: {
          bold: true,
          color: { rgb: "DA251D" }, // Red font color
          name: "Arial",
          sz: 11
        },
        alignment: {
          horizontal: "center",
          vertical: "center"
        }
      };
    }

    // Set styling for Column Headings (Row 3, indexes A3 to K3)
    const colLetters = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
    colLetters.forEach(col => {
      const cellRef = `${col}3`;
      if (ws[cellRef]) {
        ws[cellRef].s = {
          font: {
            bold: true,
            color: { rgb: "DA251D" }, // Red font color
            name: "Arial",
            sz: 10
          },
          alignment: {
            horizontal: "center",
            vertical: "center"
          }
        };
      }
    });

    // Set column widths for all 11 columns
    ws['!cols'] = [
      { wch: 8 },   // S.N.
      { wch: 16 },  // APPLICANT ID
      { wch: 26 },  // FULL NAME
      { wch: 22 },  // LICENSE NUMBER
      { wch: 14 },  // CATEGORY
      { wch: 12 },  // OLD CODE
      { wch: 12 },  // NEW CODE
      { wch: 22 },  // VISITING DATE
      { wch: 16 },  // RECEIVED BY
      { wch: 20 },  // DISTRIBUTED DATE
      { wch: 18 }   // DISTRIBUTED BY
    ];

    utilsStyle.book_append_sheet(wb, ws, "PLSMS Upload Template");

    // Write file and trigger download using styling-enabled write
    const wbout = writeStyle(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([wbout], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "PLSMS_License_Upload_Template.xlsx";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleReset = () => {
    setFile(null);
    setData([]);
    setHeaders([]);
    setColumnMapping({});
    setPreviewRows([]);
    setReport(null);
    setProgress(0);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImportExecute = async () => {
    // Validate mapping
    const required = ['applicantId', 'fullName', 'licenseNumber'];
    const missing = required.filter(r => !columnMapping[r]);
    if (missing.length > 0) {
      alert(`Missing mapped fields for: ${missing.join(', ')}. Please select headers manually.`);
      return;
    }

    setLoading(true);
    setProgress(0);
    
    let imported = 0;
    let skipped = 0;
    let updated = 0;
    const errorsList: string[] = [];
    
    const staffEmail = auth.currentUser?.email || 'dahalkomal@gmail.com';
    const totalRecords = data.length;
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    let archivedFileUrl = '';
    if (file) {
      try {
        archivedFileUrl = await archiveExcelToStorage(file);
      } catch (archiveErr) {
        console.warn("Notice during Excel file archiving step:", archiveErr);
      }
    }

    try {
      const allBatchResults: BatchWriteResult[] = [];

      // 1. Filter out completely blank or invalid rows first to get a clean set
      const cleanRows: any[] = [];
      for (let i = 0; i < data.length; i++) {
        const row = data[i];
        const rawAppId = String(row[columnMapping['applicantId']] || '').trim();
        const rawName = String(row[columnMapping['fullName']] || '').trim();
        const rawLicenseNo = String(row[columnMapping['licenseNumber']] || '').trim();
        
        if (rawAppId && rawName && rawLicenseNo) {
          cleanRows.push({ row, originalIndex: i });
        } else {
          skipped++;
        }
      }

      const totalClean = cleanRows.length;

      // Prepare all records in memory with in-file duplicate detection
      const currentTime = new Date().toISOString();
      const cleanLicenses: License[] = [];
      const seenMap = new Set<string>();

      for (let i = 0; i < cleanRows.length; i++) {
        const item = cleanRows[i];
        const row = item.row;
        const rowIdx = item.originalIndex;

        const rawAppId = String(row[columnMapping['applicantId']] || '').trim();
        const rawName = String(row[columnMapping['fullName']] || '').trim();
        const rawLicenseNo = String(row[columnMapping['licenseNumber']] || '').trim();
        const category = String(row[columnMapping['category']] || 'LTV').trim();
        let rawDept = String(
          (columnMapping['department'] && row[columnMapping['department']]) || 
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
          row['DISTRIBUTED DAY'] ||
          row['Distributed Day'] ||
          row['distributed day'] ||
          row['DIST DATE'] ||
          row['Dist Date'] ||
          row['dist date'] ||
          row['DIST DAY'] ||
          row['Dist Day'] ||
          row['dist day'] ||
          row['VISITING DATE'] ||
          row['Visiting Date'] ||
          row['visiting date'] ||
          row['VISITING DAY'] ||
          row['Visiting Day'] ||
          row['visiting day'] ||
          row['SECTION'] ||
          row['Section'] ||
          row['section'] ||
          row['ONTACT'] ||
          row['Ontact'] ||
          row['ontact'] ||
          row['CONTACT'] ||
          row['Contact'] ||
          row['contact'] ||
          row['DEPT'] ||
          row['Dept'] ||
          row['dept'] ||
          ''
        ).trim();

        if (!rawDept) {
          for (const [k, v] of Object.entries(row)) {
            if (v !== undefined && v !== null && String(v).trim() !== '') {
              const cleanK = k.toLowerCase().replace(/[\s_\-\/\.]/g, '');
              if (
                cleanK.includes('department') ||
                cleanK.includes('departman') ||
                cleanK.includes('ontactsection') ||
                cleanK.includes('contactsection') ||
                cleanK.includes('distributionday') ||
                cleanK.includes('distributiondate') ||
                cleanK.includes('distday') ||
                cleanK.includes('distdate') ||
                cleanK.includes('visitingdate') ||
                cleanK.includes('visitingday') ||
                cleanK === 'section' ||
                cleanK === 'ontact'
              ) {
                rawDept = String(v).trim();
                break;
              }
            }
          }
        }
        const oldCode = columnMapping['oldCode'] ? String(row[columnMapping['oldCode']] || '').trim() : '';
        const newCode = columnMapping['newCode'] ? String(row[columnMapping['newCode']] || '').trim() : '';
        const sn = columnMapping['sn'] && row[columnMapping['sn']] !== "" ? Number(row[columnMapping['sn']]) : (rowIdx + 1);
        const receivedBy = columnMapping['receivedBy'] ? String(row[columnMapping['receivedBy']] || '').trim() : '';
        const distributedDate = columnMapping['distributedDate'] ? String(row[columnMapping['distributedDate']] || '').trim() : '';
        const distributedBy = columnMapping['distributedBy'] ? String(row[columnMapping['distributedBy']] || '').trim() : '';
        const statusVal = columnMapping['status'] ? String(row[columnMapping['status']] || '').trim().toLowerCase() : '';

        const rawClean = rawLicenseNo ? String(rawLicenseNo).trim() : '';
        let sanitizedId = rawClean.toUpperCase().replace(/[^A-Z0-9_\-\.]/g, '');
        if (!sanitizedId && rawAppId) {
          sanitizedId = String(rawAppId).trim().toUpperCase().replace(/[^A-Z0-9_\-\.]/g, '');
        }
        if (!sanitizedId) {
          sanitizedId = 'LIC_' + (sn || rowIdx + 1);
        }

        const upperNo = rawClean.toUpperCase();
        const upperAppId = rawAppId ? String(rawAppId).trim().toUpperCase() : '';

        const isDuplicate =
          (upperNo && seenMap.has('LIC:' + upperNo)) ||
          (upperAppId && seenMap.has('APP:' + upperAppId)) ||
          seenMap.has('ID:' + sanitizedId);

        if (isDuplicate) {
          if (duplicateStrategy === 'skip') {
            skipped++;
            continue;
          } else {
            updated++;
          }
        }

        if (upperNo) seenMap.add('LIC:' + upperNo);
        if (upperAppId) seenMap.add('APP:' + upperAppId);
        seenMap.add('ID:' + sanitizedId);

        const logItem = {
          timestamp: currentTime,
          action: 'BULK_IMPORT_FAST',
          user: staffEmail,
          details: `Imported via file: ${file?.name}`
        };

        let finalStatus: LicenseStatus = (receivedBy || distributedBy || distributedDate) ? 'distributed' : 'available';
        if (statusVal === 'distributed' || statusVal === 'available' || statusVal === 'missing' || statusVal === 'found') {
          finalStatus = statusVal as LicenseStatus;
        }

        const licenseRecord: License = {
          id: sanitizedId,
          applicantId: rawAppId || '',
          fullName: rawName || '',
          licenseNumber: rawLicenseNo || '',
          category: category || 'LTV',
          department: rawDept || '',
          oldCode: oldCode || '',
          newCode: newCode || '',
          sn: typeof sn === 'number' && !isNaN(sn) ? sn : (rowIdx + 1),
          receivedBy: receivedBy || '',
          distributedDate: distributedDate || '',
          distributedByStaffName: distributedBy || '',
          status: finalStatus,
          createdAt: currentTime,
          updatedAt: currentTime,
          updatedBy: staffEmail,
          logs: [logItem]
        };

        cleanLicenses.push(licenseRecord);
      }

      // 1. Generate unique Lot Ledger ID and tag all records
      const ledgerId = `LOT_${now.getFullYear()}_${Date.now().toString().slice(-6)}`;
      cleanLicenses.forEach(lic => {
        lic.uploadId = ledgerId;
      });

      const expectedBatches = Math.max(1, Math.ceil(cleanLicenses.length / 450));
      const fileSizeStr = file ? `${(file.size / 1024).toFixed(1)} KB` : 'N/A';

      // 2. CREATE INITIAL UPLOAD LEDGER RECORD IN FIRESTORE BEFORE WRITING ANY RECORDS
      const initialLedger: UploadLedger = {
        id: ledgerId,
        timestamp: now.toISOString(),
        startedAt: now.toISOString(),
        completedAt: null,
        fileName: file?.name || 'excel_upload.xlsx',
        size: fileSizeStr,
        actionType: totalRecords > 1000 ? 'Direct High-Speed Batch Import' : 'Safe Checked Import',
        noOfLoadedRecords: totalRecords,
        totalRows: totalRecords,
        totalExcelRows: totalRecords,
        validRows: totalClean,
        invalidRows: skipped,
        skippedRows: skipped,
        duplicateRows: skipped,
        duplicateRecords: skipped,
        importedRecords: 0,
        committedRows: 0,
        failedRows: 0,
        expectedWrites: cleanLicenses.length,
        expectedBatches: expectedBatches,
        totalBatches: expectedBatches,
        successfulBatchCount: 0,
        committedBatches: 0,
        failedBatchCount: 0,
        failedBatches: 0,
        uploader: staffEmail || 'Super Admin',
        status: 'Processing',
        verificationStatus: 'PENDING',
        fileUrl: archivedFileUrl || undefined,
        isActive: true,
        errorCode: null,
        errorMessage: null
      };

      let ledgerFailed = false;
      let ledgerErrorMessage = '';
      try {
        await createUploadLedger(initialLedger);
      } catch (ledgerErr: any) {
        console.error("Critical: Failed to pre-save upload ledger entry:", ledgerErr);
        ledgerFailed = true;
        ledgerErrorMessage = ledgerErr?.message || 'Database error occurred while recording initial ledger';
        errorsList.push(`INITIAL LEDGER CREATION WARNING: ${ledgerErrorMessage}`);
      }

      // 3. Execute high-speed direct batch write with bounded concurrency (3) & max batch limit (450)
      const res = await batchWriteLicenses(
        cleanLicenses,
        (completedBatches, totalBatches) => {
          setProgress(Math.round((completedBatches / totalBatches) * 100));
        },
        { ledgerId }
      );

      allBatchResults.push(res);
      imported = res.committedRows;

      let successfulBatchCount = res.successfulBatchCount;
      let failedBatchCount = res.failedBatchCount;
      let totalDurationMs = res.verificationDurationMs;
      const aggregatedBatchDetails: BatchCommitDetail[] = res.batchDetails || [];
      const aggregatedFailedDetails: BatchCommitDetail[] = res.failedBatchDetails || [];

      let verificationStatus: 'VERIFIED' | 'PARTIAL SUCCESS' | 'FAILED' = res.verificationStatus;
      let finalStatusText: 'Completed' | 'Partial Success' | 'Failed' = 'Completed';
      if (failedBatchCount > 0 && successfulBatchCount > 0) {
        finalStatusText = 'Partial Success';
      } else if (failedBatchCount > 0 && successfulBatchCount === 0) {
        finalStatusText = 'Failed';
      }

      const finalVerificationMetrics: VerificationMetrics = {
        totalExcelRows: totalRecords,
        validRows: totalClean,
        skippedRows: skipped,
        duplicateRows: skipped,
        expectedWrites: cleanLicenses.length,
        successfulBatchCount,
        failedBatchCount,
        verificationStatus,
        verificationTime: new Date().toISOString(),
        verificationDurationMs: totalDurationMs,
        batchDetails: aggregatedBatchDetails,
        failedBatchDetails: aggregatedFailedDetails,
        missingRecordsCount: failedBatchCount > 0 ? (cleanLicenses.length - (imported + updated)) : 0
      };

      try {
        await updateUploadLedger(ledgerId, {
          status: finalStatusText,
          verificationStatus,
          completedAt: new Date().toISOString(),
          successfulBatchCount,
          committedBatches: successfulBatchCount,
          failedBatchCount,
          failedBatches: failedBatchCount,
          importedRecords: imported + updated,
          committedRows: imported + updated,
          failedRows: res.failedRows,
          errorCode: res.lastErrorCode || null,
          errorMessage: res.lastErrorMessage || (res.isQuotaExhausted ? 'Firestore quota exceeded' : null),
          ...finalVerificationMetrics
        });
      } catch (updateErr: any) {
        console.warn("Notice: Updating final ledger status:", updateErr);
      }

      if (res.isQuotaExhausted) {
        errorsList.push('Firestore write quota limit reached during batch processing. Successfully written records were safely preserved.');
      } else if (failedBatchCount > 0) {
        errorsList.push(`Batch processing notice: ${failedBatchCount} batches failed during commit.`);
      }

      setReport({
        total: totalRecords,
        imported,
        skipped,
        updated,
        errors: errorsList,
        ledgerFailed,
        ledgerErrorMessage
      });
      if ((imported + updated) > 0) {
        registryDataStore.notifySubscribers();
        onUploadSuccess();
      }
    } catch (err: any) {
      console.error("Critical fail inside bulk importer: ", err);
      errorsList.push(err?.message || "Internal transaction timeout.");

      setReport({
        total: totalRecords,
        imported,
        skipped,
        updated,
        errors: errorsList
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`rounded-3xl border shadow-2xl p-6 ${fullWidth ? 'w-full h-full flex flex-col justify-between' : 'max-w-full mx-auto'} font-sans transition-all ${
      theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
    }`}>
      <div className={`border-b pb-5 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 ${
        theme === 'dark' ? 'border-slate-800' : 'border-slate-100'
      }`}>
        <div>
          {stepBadge && (
            <span className={`inline-block text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-md mb-2 ${
              theme === 'dark' ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/50' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'
            }`}>
              {stepBadge}
            </span>
          )}
          <h2 className={`text-xl font-bold tracking-tight flex items-center gap-2 ${
            theme === 'dark' ? 'text-white' : 'text-slate-900'
          }`}>
            <FileSpreadsheet className="w-5 h-5 text-emerald-500 shrink-0" />
            <span>{title || 'Excel Ledger Importer'}</span>
          </h2>
          <p className={`text-sm mt-1 ${
            theme === 'dark' ? 'text-slate-400' : 'text-slate-600'
          }`}>
            {subtitle || 'Perform high-performance spreadsheet records uploading (.xlsx or .csv) directly to Cloud Firestore.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0 self-start sm:self-center">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              downloadPdfSampleTemplate();
            }}
            title="Download PDF format sample template"
            className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-black uppercase tracking-wider rounded-xl border transition-all active:scale-95 cursor-pointer shadow-xs ${
              theme === 'dark'
                ? 'bg-rose-950/40 border-rose-800/60 hover:bg-rose-900/50 text-rose-300'
                : 'bg-rose-50 border-rose-200 hover:bg-rose-100 text-rose-800'
            }`}
          >
            <FileText className="w-4 h-4 text-rose-500" />
            PDF Sample Template
          </button>
          <button
            type="button"
            onClick={downloadTemplate}
            title="Download Excel XLSX format sample template"
            className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-black uppercase tracking-wider rounded-xl border transition-all active:scale-95 cursor-pointer shadow-xs ${
              theme === 'dark'
                ? 'bg-slate-800 border-slate-700 hover:border-emerald-500 hover:bg-emerald-955/15 text-emerald-400'
                : 'bg-slate-50 border-slate-200 hover:border-emerald-500 hover:bg-emerald-50 text-emerald-700'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4 text-emerald-500" />
            Excel Sample (.xlsx)
          </button>
        </div>
      </div>

      {!file ? (
        <div
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-2xl p-10 flex-1 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-300 group ${
            theme === 'dark' 
              ? 'border-slate-700 hover:border-emerald-500 bg-slate-950 hover:bg-emerald-950/10' 
              : 'border-slate-300 hover:border-emerald-500 bg-slate-50 hover:bg-emerald-50/20'
          }`}
        >
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept=".xlsx, .xls, .csv"
            className="hidden"
          />
          <div className={`w-12 h-12 rounded-full group-hover:scale-110 transition-all flex items-center justify-center border animate-pulse ${
            theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-white border-slate-200'
          }`}>
            <Upload className="w-6 h-6 text-slate-500 group-hover:text-emerald-400" />
          </div>
          <div className="text-center">
            <p className={`font-semibold text-sm ${theme === 'dark' ? 'text-white' : 'text-slate-800'}`}>Drag and Drop your Excel/CSV here</p>
            <p className="text-xs text-slate-500 mt-1">or click to browse local files (limit 200,000 driving licenses)</p>
          </div>
          <span className={`text-[10px] px-2 py-0.5 rounded-md font-bold tracking-wider uppercase ${
            theme === 'dark' ? 'bg-slate-855 bg-slate-800 text-slate-400' : 'bg-slate-100 text-slate-600'
          }`}>
            XLSX, XLS, CSV Supported
          </span>
        </div>
      ) : (
        <div className="space-y-6">
          <div className={`rounded-2xl p-4 border flex items-center justify-between transition-colors ${
            theme === 'dark' ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
          }`}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-955/20 text-emerald-400 border border-emerald-900/35 rounded-lg flex items-center justify-center">
                <FileSpreadsheet className="w-5 h-5" />
              </div>
              <div>
                <span className={`font-bold block text-sm ${theme === 'dark' ? 'text-white' : 'text-slate-800'}`}>{file.name}</span>
                <span className="text-[10px] text-slate-400 font-mono">Total sheets records parsed: {data.length}</span>
              </div>
            </div>
            
            <button
              onClick={handleReset}
              disabled={loading}
              className={`text-xs font-bold px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                theme === 'dark'
                  ? 'text-slate-400 hover:text-red-400 hover:bg-red-955/20 border-slate-800 hover:border-red-900/30'
                  : 'text-slate-600 hover:text-red-650 hover:bg-red-50 border-slate-200 hover:border-red-200'
              }`}
            >
              Reset File
            </button>
          </div>

          {/* Table Preview */}
          <div className="space-y-2">
            <h3 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
              theme === 'dark' ? 'text-slate-350' : 'text-slate-700'
            }`}>
              <Table className="w-4 h-4 text-emerald-400" />
              Spreadsheet Headers Alignment & Preview
            </h3>
            
            <div className={`p-4 rounded-2xl border space-y-4 transition-all ${
              theme === 'dark' ? 'bg-slate-950 border-slate-800' : 'bg-slate-50 border-slate-200'
            }`}>
              <p className={`text-xs leading-normal ${theme === 'dark' ? 'text-slate-400' : 'text-slate-600'}`}>
                To prevent structural failures, map your spreadsheet's column names to the PLSMS fields. The system automatically pre-matches best fits.
              </p>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 pb-2">
                {[
                  { key: 'sn', label: 'S.N. (Serial No)' },
                  { key: 'applicantId', label: 'Applicant ID *' },
                  { key: 'fullName', label: 'Full Name *' },
                  { key: 'licenseNumber', label: 'License Number *' },
                  { key: 'category', label: 'Category' },
                  { key: 'oldCode', label: 'Old Code' },
                  { key: 'newCode', label: 'New Code' },
                  { key: 'department', label: 'Department / Contact Section / Distribution Date/Day' },
                  { key: 'receivedBy', label: 'Received By' },
                  { key: 'distributedDate', label: 'Distributed Date' },
                  { key: 'distributedBy', label: 'Distributed By' },
                  { key: 'status', label: 'Status' },
                ].map((item) => (
                  <div key={item.key} className="space-y-1">
                    <label className={`block text-[10px] font-bold uppercase tracking-wide ${theme === 'dark' ? 'text-slate-400' : 'text-slate-500'}`}>{item.label}</label>
                    <select
                      value={columnMapping[item.key] || ''}
                      onChange={(e) => handleMapChange(item.key, e.target.value)}
                      className={`w-full px-3 py-2 rounded-xl text-xs focus:outline-hidden focus:border-cyan-500 transition-all ${
                        theme === 'dark' ? 'bg-slate-900 border-slate-700 text-white' : 'bg-white border-[#ccc] text-slate-800'
                      }`}
                    >
                      <option value="">-- No Match --</option>
                      {headers.map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              {/* Data Table */}
              {(() => {
                const isSerialHeader = (header: string) => {
                  const norm = header.toLowerCase().trim().replace(/[\s_\-\/\.]/g, '');
                  return norm === 'sn' || norm === 'sno' || norm === 'serialnumber' || norm === 'serialno';
                };
                const displayedHeaders = headers.filter(h => !isSerialHeader(h));
                return (
                  <div className={`overflow-x-auto border rounded-xl max-h-48 transition-all ${
                    theme === 'dark' ? 'border-slate-800 bg-slate-900' : 'border-slate-200 bg-white'
                  }`}>
                    <table className="w-full text-left text-[11px] border-collapse">
                      <thead>
                        <tr className={`border-b text-[10px] font-extrabold uppercase transition-all ${
                          theme === 'dark' ? 'bg-slate-950 border-slate-800 text-red-400' : 'bg-slate-50 border-slate-200 text-red-800'
                        }`}>
                          <th className={`px-2 py-1.5 w-10 text-center border-r ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>SN</th>
                          {displayedHeaders.slice(0, 6).map((h, hIdx) => (
                            <th key={h} className={`px-2 py-1.5 border-r ${
                              theme === 'dark' ? 'border-slate-800' : 'border-slate-200'
                            } ${hIdx === 5 ? 'border-r-0' : ''}`}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {previewRows.map((r, rowIdx) => {
                          const rowBgClass = theme === 'dark'
                            ? (rowIdx % 2 === 0 ? 'bg-slate-950 hover:bg-slate-900/20' : 'bg-slate-900/40 hover:bg-slate-900/60')
                            : (rowIdx % 2 === 0 ? 'bg-white hover:bg-slate-100/70' : 'bg-[#f2f7fc] hover:bg-slate-100/70');
                          return (
                            <tr key={rowIdx} className={`border-b transition-all ${rowBgClass} ${
                              theme === 'dark' ? 'border-slate-850' : 'border-slate-150'
                            }`}>
                               <td className={`px-2 py-1 font-normal text-[12px] uppercase text-center w-10 border-r ${
                                theme === 'dark' ? 'border-slate-850 text-white' : 'border-slate-200 text-slate-900'
                              }`}>{rowIdx + 1}</td>
                              {displayedHeaders.slice(0, 6).map((h, dIdx) => (
                                <td key={h} className={`px-2 py-1 truncate max-w-[150px] font-normal text-[12px] uppercase border-r transition-colors ${
                                  theme === 'dark' ? 'border-slate-850 text-white' : 'border-slate-200 text-slate-900'
                                } ${dIdx === 5 ? 'border-r-0' : ''}`}>{r[h]}</td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Duplicate Strategies Section */}
          <div className="space-y-2">
            <h3 className={`text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 ${
              theme === 'dark' ? 'text-white' : 'text-slate-800'
            }`}>
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Duplicate Interception Rule (Section 9)
            </h3>
            
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { value: 'skip', label: 'Skip Existing Records', desc: 'Ignore matches; only insert brand new licenses.' },
                { value: 'update', label: 'Merge & Update', desc: 'Overwrites meta fields (Category, pickup) but preserves status histories.' },
                { value: 'replace', label: 'Overwrite Fully', desc: 'Wipes the existing Firestore snapshot completely and resets statuses.' },
              ].map((strategy) => (
                <button
                  key={strategy.value}
                  type="button"
                  onClick={() => setDuplicateStrategy(strategy.value as any)}
                  className={`p-3.5 rounded-xl border text-left flex flex-col transition-all cursor-pointer ${
                    duplicateStrategy === strategy.value 
                      ? 'bg-amber-500/10 border-amber-500 text-amber-600 dark:text-amber-300 shadow-md ring-1 ring-amber-500/25' 
                      : theme === 'dark' 
                        ? 'bg-slate-955 bg-slate-950 border-slate-800 hover:border-slate-700' 
                        : 'bg-slate-50 border-slate-200 hover:border-slate-300 hover:bg-slate-100/50'
                  }`}
                >
                  <span className={`text-xs mb-1 ${
                    duplicateStrategy === strategy.value 
                      ? theme === 'dark' 
                        ? 'text-amber-300 font-bold' 
                        : 'text-white font-black' 
                      : theme === 'dark' 
                        ? 'text-slate-200' 
                        : 'text-slate-800 font-bold'
                  }`}>
                    {strategy.label}
                  </span>
                  <span className={`text-[10px] leading-normal ${
                    duplicateStrategy === strategy.value 
                      ? theme === 'dark' 
                        ? 'text-slate-400' 
                        : 'text-white/95 font-medium' 
                      : 'text-slate-500'
                  }`}>
                    {strategy.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Importer action & loader */}
          {loading ? (
            <div className={`p-5 rounded-2xl border space-y-2 ${
              theme === 'dark' ? 'bg-slate-955 bg-slate-950 border-slate-800' : 'bg-slate-100 border-slate-200'
            }`}>
              <div className={`flex items-center justify-between text-xs font-bold uppercase ${theme === 'dark' ? 'text-slate-300' : 'text-slate-705 text-slate-700'}`}>
                <span>Bulk Transaction Running...</span>
                <span>{progress}%</span>
              </div>
              <div className={`w-full h-2.5 rounded-full overflow-hidden ${theme === 'dark' ? 'bg-slate-900' : 'bg-slate-200'}`}>
                <div className="h-full bg-emerald-500 transition-all duration-300" style={{ width: `${progress}%` }} />
              </div>
              <p className="text-[10px] text-slate-500">Processing records in real-time. Do not close browser during database write operations.</p>
            </div>
          ) : (
            <div className={`pt-4 border-t flex justify-end gap-2.5 ${theme === 'dark' ? 'border-slate-800' : 'border-slate-200'}`}>
              <button
                type="button"
                onClick={handleReset}
                className={`px-5 py-2.5 text-xs font-bold rounded-xl border transition-colors cursor-pointer ${
                  theme === 'dark'
                    ? 'text-slate-400 bg-slate-900 border-slate-800 hover:bg-slate-800'
                    : 'text-slate-600 bg-slate-100 border-slate-200 hover:bg-slate-200'
                }`}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleImportExecute}
                className="flex items-center gap-1.5 px-6 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition-all active:scale-95 cursor-pointer shadow-md"
              >
                <Play className="w-4 h-4 fill-white text-white" />
                Initialize Bulk Import
              </button>
            </div>
          )}

          {/* Completed Report */}
          {report && (
            <div className={`p-5 rounded-2xl border space-y-4 shadow-xl ${
              theme === 'dark' ? 'bg-slate-950 text-white border-slate-800' : 'bg-white text-slate-850 text-slate-800 border-slate-200'
            }`}>
              <div className={`flex items-center gap-2 text-xs font-bold uppercase tracking-widest border-b pb-2 ${
                report.ledgerFailed
                  ? 'text-amber-500 border-amber-800/60'
                  : report.errors.length > 0 && (report.imported + report.updated) === 0
                    ? 'text-red-500 border-slate-900'
                    : report.errors.length > 0
                      ? 'text-amber-500 border-slate-900'
                      : theme === 'dark' ? 'text-emerald-400 border-slate-900' : 'text-emerald-650 border-slate-100'
              }`}>
                {report.ledgerFailed ? (
                  <>
                    <AlertTriangle className="w-4 h-4 text-amber-500 animate-pulse" />
                    <span>LICENSE DATA COMMITTED — LEDGER CREATION FAILED</span>
                  </>
                ) : report.errors.length > 0 && (report.imported + report.updated) === 0 ? (
                  <>
                    <AlertCircle className="w-4 h-4 text-red-500" />
                    <span>Upload Failed — Database Commit Error</span>
                  </>
                ) : report.errors.length > 0 ? (
                  <>
                    <AlertTriangle className="w-4 h-4 text-amber-500" />
                    <span>Upload Completed with Batch Errors</span>
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4 text-emerald-500" />
                    <span>Import Process Complete (Section 8 Report)</span>
                  </>
                )}
              </div>
              
              <div className="grid grid-cols-4 gap-4 py-2 text-center">
                <div className={`p-3 rounded-xl border ${theme === 'dark' ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'}`}>
                  <span className="block text-slate-550 text-slate-500 text-[9px] font-bold uppercase tracking-wider">Total Evaluated</span>
                  <span className={`font-mono font-bold text-lg ${theme === 'dark' ? 'text-white' : 'text-slate-900'}`}>{report.total}</span>
                </div>
                <div className="bg-emerald-500/10 dark:bg-emerald-955/20 p-3 rounded-xl border border-emerald-500/20 dark:border-emerald-900/35">
                  <span className="block text-emerald-600 dark:text-emerald-400 text-[9px] font-bold uppercase tracking-wider">Successfully Imported</span>
                  <span className="font-mono font-bold text-lg text-emerald-600 dark:text-emerald-400">{report.imported}</span>
                </div>
                <div className="bg-amber-500/10 dark:bg-amber-955/20 p-3 rounded-xl border border-amber-500/20 dark:border-amber-900/35">
                  <span className="block text-amber-600 dark:text-amber-400 text-[9px] font-bold uppercase tracking-wider">Skipped duplicates</span>
                  <span className="font-mono font-bold text-lg text-amber-600 dark:text-amber-400">{report.skipped}</span>
                </div>
                <div className="bg-blue-500/10 dark:bg-blue-955/20 p-3 rounded-xl border border-blue-500/20 dark:border-blue-900/35">
                  <span className="block text-blue-600 dark:text-blue-400 text-[9px] font-bold uppercase tracking-wider">Updated records</span>
                  <span className="font-mono font-bold text-lg text-blue-650 dark:text-blue-400">{report.updated}</span>
                </div>
              </div>

              {report.errors.length > 0 && (
                <div className="p-3 bg-red-955/15 border border-red-900/35 text-red-100 text-red-450 rounded-xl text-xs space-y-1">
                  <span className="font-semibold flex items-center gap-1 text-red-400"><AlertCircle className="w-3.5 h-3.5" /> Operations Log warnings:</span>
                  <ul className="list-disc list-inside space-y-0.5 text-[11px] text-red-350">
                    {report.errors.map((err, i) => (
                      <li key={i}>{err}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
