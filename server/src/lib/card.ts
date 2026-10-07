export function luhnValid(pan: string) {
  let sum = 0;
  let double = false;
  for (let i = pan.length - 1; i >= 0; i--) {
    let d = Number(pan[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

export function detectBrand(pan: string): string {
  if (/^4/.test(pan)) return 'visa';
  if (/^(5[1-5]|2[2-7])/.test(pan)) return 'mastercard';
  if (/^(506[01]|507[89]|6500)/.test(pan)) return 'verve';
  return 'unknown';
}

export function isExpired(month: string, year: string) {
  const y = Number(year.length === 2 ? `20${year}` : year);
  const m = Number(month);
  const now = new Date();
  return y < now.getFullYear() || (y === now.getFullYear() && m < now.getMonth() + 1);
}
