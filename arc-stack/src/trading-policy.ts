export const PRICE_SCALE_PPM = 1_000_000n;
export const MIN_ORDER_PRICE_PPM = 1_000n;
export const MAX_ORDER_PRICE_PPM = 999_000n;
export const MIN_ORDER_QUANTITY_ATOMS = 10_000n;
export const ORDER_QUANTITY_STEP_ATOMS = 10_000n;
export const MAX_ORDER_QUANTITY_ATOMS = 100_000_000n;

export function isExecutableOrderQuantity(quantity: bigint): boolean {
  return quantity >= MIN_ORDER_QUANTITY_ATOMS
    && quantity <= MAX_ORDER_QUANTITY_ATOMS
    && quantity % ORDER_QUANTITY_STEP_ATOMS === 0n;
}
