/**
 * Returns the Tailwind text color class for a transaction amount.
 *
 * Credit accounts (credit cards) have an inverted sign convention:
 * a positive amount means the balance owed went up (money spent → red),
 * while a negative amount is a payment or refund (net worth up → green).
 * Depository accounts use the standard convention (positive = income = green).
 * Transfers have no net-worth impact and use the default text color.
 */
export function txAmountColor(
  amount: number,
  accountType: string | null,
  categorySlug: string | null,
): string {
  if (categorySlug === 'transfer') return '';
  const isCredit = accountType === 'credit';
  const isGain = isCredit ? amount < 0 : amount > 0;
  return isGain ? 'text-accent-success' : 'text-accent-danger';
}
