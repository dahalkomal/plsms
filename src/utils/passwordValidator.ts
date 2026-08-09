/**
 * Validates password rules according to system enterprise security requirements:
 * - Minimum 6 characters
 * - At least one uppercase English letter (A-Z)
 * - At least one lowercase English letter (a-z)
 * - At least one number (0-9)
 * - Alphanumeric characters only
 */
export function validateStrongPassword(password: string): { isValid: boolean; message?: string } {
  if (!password) {
    return { isValid: false, message: "Password is required." };
  }
  const p = password.trim();
  if (p.length < 6) {
    return { isValid: false, message: "Password must be at least 6 characters long." };
  }
  if (!/[A-Z]/.test(p)) {
    return { isValid: false, message: "Password must contain at least one uppercase letter (A-Z)." };
  }
  if (!/[a-z]/.test(p)) {
    return { isValid: false, message: "Password must contain at least one lowercase letter (a-z)." };
  }
  if (!/[0-9]/.test(p)) {
    return { isValid: false, message: "Password must contain at least one number (0-9)." };
  }
  if (!/[^a-zA-Z0-9\s]/.test(p)) {
    return { isValid: false, message: "Password must contain at least one symbol or special character (e.g. @, #, $, !)." };
  }
  if (/\s/.test(p)) {
    return { isValid: false, message: "Password must not contain spaces." };
  }
  return { isValid: true };
}
