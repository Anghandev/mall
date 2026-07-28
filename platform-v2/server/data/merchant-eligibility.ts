export function isMerchantOperationallyEligible(status: string | null | undefined, guaranteeStatus?: string | null) {
  return status === 'APPROVED' && guaranteeStatus !== 'FROZEN';
}
