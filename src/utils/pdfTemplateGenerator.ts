import { jsPDF } from 'jspdf';
import { getOfficeSettings } from '../dbService';

export async function downloadPdfSampleTemplate(): Promise<void> {
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
    console.error("Failed to fetch office settings for PDF template:", err);
  }

  const doc = new jsPDF({
    orientation: 'landscape',
    unit: 'mm',
    format: 'a4'
  });

  // A4 Landscape dimensions: 297mm x 210mm
  const pageWidth = doc.internal.pageSize.getWidth(); // 297

  // Background Header Box for Office Name and Address
  doc.setFillColor(254, 242, 242); // Very light red background tint
  doc.setDrawColor(252, 165, 165); // Soft red border
  doc.rect(12, 10, 273, 18, 'DF');

  // Title Text - Merged Office Name (Red, Bold, Centered)
  doc.setTextColor(218, 37, 29); // Official Red
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(officeName, pageWidth / 2, 17, { align: 'center' });

  // Office Address (Red, Bold, Centered)
  doc.setFontSize(10);
  doc.text(officeAddress, pageWidth / 2, 24, { align: 'center' });

  // Document metadata header
  doc.setTextColor(71, 85, 105); // slate-600
  doc.setFontSize(8.5);
  doc.setFont('helvetica', 'bold');
  doc.text("DOCUMENT TYPE: OFFICIAL DRIVING LICENSE LEDGER UPLOAD TEMPLATE", 12, 33);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated Date: ${new Date().toLocaleDateString('en-GB')}`, pageWidth - 12, 33, { align: 'right' });

  // Draw Table Headers (11 Columns matching Picture 1)
  const startY = 36;
  // 11 column widths summing to 273mm
  const colWidths = [9, 22, 40, 32, 18, 16, 16, 30, 28, 31, 31];
  const headers = [
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

  let currentX = 12;

  // Header background row
  doc.setFillColor(254, 226, 226); // Light red/rose header bar
  doc.setDrawColor(239, 68, 68); // Red border line
  doc.rect(12, startY, 273, 9, 'DF');

  doc.setTextColor(218, 37, 29); // Red text matching Excel design
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);

  headers.forEach((h, idx) => {
    const w = colWidths[idx];
    // Split long headers onto 2 lines if needed
    if (h === "LICENSE NUMBER") {
      doc.text("LICENSE", currentX + (w / 2), startY + 3.8, { align: 'center' });
      doc.text("NUMBER", currentX + (w / 2), startY + 7.2, { align: 'center' });
    } else if (h === "DEPARTMENT") {
      doc.text("DEPARTMENT", currentX + (w / 2), startY + 5.5, { align: 'center' });
    } else if (h === "DISTRIBUTED DATE") {
      doc.text("DISTRIBUTED", currentX + (w / 2), startY + 3.8, { align: 'center' });
      doc.text("DATE", currentX + (w / 2), startY + 7.2, { align: 'center' });
    } else if (h === "DISTRIBUTED BY") {
      doc.text("DISTRIBUTED", currentX + (w / 2), startY + 3.8, { align: 'center' });
      doc.text("BY", currentX + (w / 2), startY + 7.2, { align: 'center' });
    } else if (h === "APPLICANT ID") {
      doc.text("APPLICANT", currentX + (w / 2), startY + 3.8, { align: 'center' });
      doc.text("ID", currentX + (w / 2), startY + 7.2, { align: 'center' });
    } else {
      doc.text(h, currentX + (w / 2), startY + 5.8, { align: 'center' });
    }
    currentX += w;
  });

  // Sample Rows Data
  const sampleRows = [
    ["1", "1025443", "Ram Bahadur Shrestha", "01-06-00021350", "LTV (B)", "A-304", "B-987", "Distribution Section", "System Admin", "12/05/2025", "Staff 01"],
    ["2", "1025444", "Sita Maya Tamang", "01-06-00021351", "Motorcycle (A)", "A-305", "B-988", "Distribution Section", "System Admin", "12/05/2025", "Staff 01"],
    ["3", "1025445", "Hari Prasad Dahal", "01-06-00021352", "Heavy (C, E)", "A-306", "B-989", "Distribution Section", "System Admin", "", ""],
    ["4", "1025446", "Anita Kumari Rai", "01-06-00021353", "Scooter (K)", "A-307", "B-990", "Distribution Section", "System Admin", "", ""],
    ["5", "1025447", "Bikram Thapa", "01-06-00021354", "Car/Jeep (B)", "A-308", "B-991", "License Unit", "System Admin", "", ""],
    ["6", "1025448", "Deepak Kumar Chaudhary", "01-06-00021355", "A, B", "A-309", "B-992", "License Unit", "System Admin", "", ""],
    ["7", "1025449", "Sunita Sharma Subedi", "01-06-00021356", "B, K", "A-310", "B-993", "License Unit", "System Admin", "", ""],
    ["8", "1025450", "Manish Raj Gautam", "01-06-00021357", "LTV (B)", "A-311", "B-994", "License Unit", "System Admin", "", ""]
  ];

  let currentY = startY + 9;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);

  sampleRows.forEach((row, rIdx) => {
    // Zebra background
    if (rIdx % 2 === 1) {
      doc.setFillColor(248, 250, 252); // slate-50
      doc.rect(12, currentY, 273, 7, 'F');
    }
    
    // Draw row grid line
    doc.setDrawColor(226, 232, 240); // slate-200
    doc.rect(12, currentY, 273, 7, 'S');

    currentX = 12;
    doc.setTextColor(30, 41, 59);

    row.forEach((val, cIdx) => {
      const w = colWidths[cIdx];
      // Align left for name, center for others
      if (cIdx === 2) {
        doc.text(val, currentX + 2, currentY + 4.8);
      } else {
        doc.text(val, currentX + (w / 2), currentY + 4.8, { align: 'center' });
      }
      currentX += w;
    });

    currentY += 7;
  });

  // Instructions / Guidelines Box
  currentY += 6;
  doc.setFillColor(240, 253, 250); // emerald-50
  doc.setDrawColor(16, 185, 129); // emerald-500
  doc.rect(12, currentY, 273, 38, 'DF');

  doc.setTextColor(4, 120, 87); // emerald-700
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.5);
  doc.text("INSTRUCTIONS FOR PREPARING EXCEL / CSV LEDGER FILE FOR UPLOAD:", 16, currentY + 6);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(30, 41, 59);

  const instructions = [
    "1. Required Columns: APPLICANT ID (आवेदन नम्बर), FULL NAME (पूरा नाम), and LICENSE NUMBER (लाइसेन्स नम्बर) are mandatory.",
    "2. Optional Columns: CATEGORY, OLD CODE, NEW CODE, VISITING DATE, RECEIVED BY, DISTRIBUTED DATE, DISTRIBUTED BY.",
    "3. Merge Header Structure: Row 1 contains Office Name (Merged A1:K1), Row 2 contains Office Address (Merged A2:K2), Row 3 contains Column Headers.",
    "4. Supported File Formats: Prepare your file in Microsoft Excel (.xlsx, .xls) or Comma Separated Values (.csv).",
    "5. System Mapping: The Advanced Mapping Ledger Importer will automatically auto-detect and pair header column names."
  ];

  let instY = currentY + 11.5;
  instructions.forEach((inst) => {
    doc.text(inst, 18, instY);
    instY += 5;
  });

  // Footer Signature Line
  const footerY = 192;
  doc.setDrawColor(100, 116, 139);
  doc.setLineDashPattern([1, 1], 0);
  doc.line(210, footerY, 275, footerY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.setTextColor(15, 23, 42);
  doc.text("AUTHORISED IT CONTROLLER", 242.5, footerY + 4, { align: 'center' });

  // Save the PDF
  doc.save("PLSMS_Sample_Ledger_Upload_Template.pdf");
}
