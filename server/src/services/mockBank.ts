/**
 * Mock issuing bank / card network. In production this is a processor integration (e.g. Interswitch, NIBSS,
 * Visa/Mastercard via an acquirer). Outcomes are driven by test card numbers, like Paystack's test cards.
 */
export const TEST_CARDS = {
  SUCCESS: '4084084084084081',
  SUCCESS_MASTERCARD: '5399838383838381',
  OTP_REQUIRED: '5060666666666666666',
  INSUFFICIENT_FUNDS: '4000000000000002',
} as const;

export const TEST_OTP = '123456';

export type BankDecision =
  | { result: 'approved'; message: string }
  | { result: 'otp_required'; otp: string; message: string }
  | { result: 'declined'; message: string };

export async function authorize(pan: string, _amountKobo: number): Promise<BankDecision> {
  await new Promise((r) => setTimeout(r, 600)); // simulate network latency to the issuer
  switch (pan) {
    case TEST_CARDS.SUCCESS:
    case TEST_CARDS.SUCCESS_MASTERCARD:
      return { result: 'approved', message: 'Approved' };
    case TEST_CARDS.OTP_REQUIRED:
      return { result: 'otp_required', otp: TEST_OTP, message: 'Please enter the OTP sent to your phone' };
    case TEST_CARDS.INSUFFICIENT_FUNDS:
      return { result: 'declined', message: 'Declined: insufficient funds' };
    default:
      return { result: 'declined', message: 'Declined: card not supported in test mode' };
  }
}
