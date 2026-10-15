/**
 * Detection of sensitive values typed during a recording. Sensitive values
 * are NEVER stored: the step value becomes a {{parameter}} the operator
 * provides at run time.
 */

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'iban', re: /^[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}$/i },
  { kind: 'codice_fiscale', re: /^[A-Z]{6}\d{2}[A-EHLMPRST]\d{2}[A-Z]\d{3}[A-Z]$/i },
  { kind: 'carta', re: /^(?:\d[ -]?){13,19}$/ },
  { kind: 'cvv', re: /^\d{3,4}$/ },
];

const SENSITIVE_LABEL = /(password|passwd|pwd|pin\b|otp|cvv|cvc|token|segreto|secret|iban|carta|card|codice fiscale|tax code|ssn)/i;

/** Returns the kind of sensitive data, or null. `cvv` only matches when the label says so. */
export function sensitiveKind(value: string, label = '', inputType = ''): string | null {
  if (inputType === 'password') return 'password';
  const v = (value ?? '').trim();
  if (!v) return null;
  const labelHit = SENSITIVE_LABEL.test(label);
  for (const p of PATTERNS) {
    if (p.kind === 'cvv') {
      if (labelHit && /cvv|cvc/i.test(label) && p.re.test(v)) return 'cvv';
      continue;
    }
    if (p.kind === 'carta' && !luhn(v.replace(/[ -]/g, ''))) continue;
    if (p.re.test(v)) return p.kind;
  }
  if (labelHit) return 'secret';
  return null;
}

function luhn(num: string): boolean {
  if (!/^\d{13,19}$/.test(num)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}
