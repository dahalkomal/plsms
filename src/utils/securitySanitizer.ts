/**
 * Enterprise Security Hardening Utility for Printed License Search Management System (PLSMS)
 * Provides input sanitization, formula injection prevention, rate limiting, and safe error masking.
 */

/**
 * Sanitizes input text to prevent XSS, HTML injection, script injection, and control character attacks.
 */
export function sanitizeInputString(val: unknown, maxLength = 1000): string {
  if (val === null || val === undefined) return '';
  let str = String(val);
  
  // Strip null bytes and dangerous control characters
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Strip script/style tags and inline event handlers
  str = str.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  str = str.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  str = str.replace(/on\w+\s*=/gi, '');

  // Escape basic HTML special characters
  str = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
    .replace(/\//g, '&#x2F;');

  // Truncate if exceeds max length
  if (str.length > maxLength) {
    str = str.substring(0, maxLength);
  }

  return str.trim();
}

/**
 * Neutralizes Excel Formula Injection (CSV/Spreadsheet injection).
 * Prevents execution of dangerous formulas starting with =, +, -, @, \t, or \r.
 */
export function sanitizeExcelCell(val: unknown): string {
  if (val === null || val === undefined) return '';
  let cellStr = String(val).trim();

  // If cell value starts with formula triggers, prepend a single quote to neutralize
  if (/^[=\+\-@\t\r]/.test(cellStr)) {
    cellStr = "'" + cellStr;
  }

  return sanitizeInputString(cellStr, 2000);
}

/**
 * Converts raw technical system/Firestore errors into sanitized, user-friendly messages.
 * Prevents disclosure of GCP project IDs, internal collection paths, or raw stack traces.
 */
export function sanitizeErrorMessage(err: unknown, fallbackMessage = "An unexpected error occurred. Please try again."): string {
  if (!err) return fallbackMessage;

  const rawMsg = typeof err === 'string' ? err : (err as any)?.message || String(err);
  const lower = rawMsg.toLowerCase();

  // Suppress technical quota or limit messages completely
  if (lower.includes('quota') || lower.includes('resource-exhausted') || lower.includes('resource_exhausted') || lower.includes('free daily read units') || lower.includes('firestore.googleapis.com') || lower.includes('quota limit')) {
    return "";
  }

  // Check for common safe user messages
  if (rawMsg.includes('permission-denied') || rawMsg.includes('Missing or insufficient permissions')) {
    return "Access Denied: You do not have sufficient authorization to perform this operation.";
  }
  if (rawMsg.includes('unauthenticated') || rawMsg.includes('User not signed in')) {
    return "Authentication Error: Please log in to proceed.";
  }
  if (rawMsg.includes('not-found')) {
    return "The requested record could not be found.";
  }
  if (rawMsg.includes('already-exists')) {
    return "A record with this identifier already exists.";
  }

  // Hide internal paths, project IDs, stack trace details
  if (rawMsg.includes('projects/') || rawMsg.includes('databases/') || rawMsg.includes('documents/') || rawMsg.includes('at ') || rawMsg.includes('project_number:')) {
    return fallbackMessage;
  }

  // Return sanitized version if short and user-friendly
  if (rawMsg.length < 150 && !/[{<>]/.test(rawMsg)) {
    return sanitizeInputString(rawMsg, 150);
  }

  return fallbackMessage;
}

/**
 * Client-side rate limiter for sensitive actions (search, login, bulk execution).
 * Uses a sliding window algorithm in browser memory.
 */
const rateLimitMap: Map<string, number[]> = new Map();

export function checkRateLimit(actionKey: string, maxRequests = 30, windowMs = 60000): { allowed: boolean; retryAfterSec?: number } {
  const now = Date.now();
  const timestamps = rateLimitMap.get(actionKey) || [];

  // Filter timestamps within window
  const validTimestamps = timestamps.filter(t => now - t < windowMs);

  if (validTimestamps.length >= maxRequests) {
    const oldest = validTimestamps[0];
    const retryAfterSec = Math.ceil((oldest + windowMs - now) / 1000);
    return { allowed: false, retryAfterSec };
  }

  validTimestamps.push(now);
  rateLimitMap.set(actionKey, validTimestamps);
  return { allowed: true };
}

/**
 * Validates standard License Number and Applicant ID format constraints.
 */
export function validateRecordIdentifiers(licenseNo: string, applicantId: string): { isValid: boolean; error?: string } {
  if (!licenseNo || licenseNo.trim().length === 0) {
    return { isValid: false, error: "License Number cannot be empty." };
  }
  if (!applicantId || applicantId.trim().length === 0) {
    return { isValid: false, error: "Applicant ID cannot be empty." };
  }
  if (licenseNo.length > 50) {
    return { isValid: false, error: "License Number exceeds maximum length of 50 characters." };
  }
  if (applicantId.length > 50) {
    return { isValid: false, error: "Applicant ID exceeds maximum length of 50 characters." };
  }
  return { isValid: true };
}
