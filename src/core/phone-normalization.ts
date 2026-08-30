/** Normalize North-American and already-international phone numbers to E.164. */
export function normalizePhoneNumber(input: string, defaultCountryCode = "1"): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("Phone number is required");
  if (/^(sip|sips):/i.test(trimmed)) return trimmed.toLowerCase();
  const hasPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (!hasPlus && digits.length === 10) digits = `${defaultCountryCode}${digits}`;
  if (digits.length < 8 || digits.length > 15 || digits.startsWith("0")) {
    throw new Error(`Invalid phone number "${input}"; expected E.164 or a 10-digit NANP number`);
  }
  return `+${digits}`;
}

