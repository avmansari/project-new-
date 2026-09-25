import type { OrderStatus } from "../services/orders.js";

export interface PaymentView {
  amountZats: bigint;
  confirmations: number;
  firstSeenAt: Date;
  dropped: boolean;
}

export interface OrderView {
  status: OrderStatus;
  amountZats: bigint;
  expiresAt: Date;
}

export interface Decision {
  status: OrderStatus;
  /** Confirmed (>= minConf) paisa jo is address pe aaya */
  receivedZats: bigint;
  /** Kitna wapas karna hai (overpay / late / partial-expired) */
  refundDueZats: bigint;
  /** Poora amount time pe dikh chuka hai (confirm hona baaki ho sakta hai) => supply reserved rahega */
  funded: boolean;
}

const sum = (xs: PaymentView[]) => xs.reduce((a, p) => a + p.amountZats, 0n);

/**
 * PURE function: sirf input dekh ke decision deta hai, DB ya network ko nahi chhuta.
 * Isliye isko test karna aasan hai, aur har scan pe dobara chalane se same result aata hai (idempotent).
 *
 * Rules:
 *  - "On time" = payment expiry se pehle dikha (hamare watcher ne dekha).
 *  - "paid" tab hi jab on-time + confirmed payments >= amount.
 *  - Overpay => paid, excess refund_due mein.
 *  - Underpay => pending; expiry ke baad jo confirmed paisa aaya wo refund_needed.
 *  - Late payment (expiry ke baad dikha) => kabhi fulfil nahi hota, seedha refund_due.
 *    (Kyunki tab tak supply kisi aur ko mil chuka ho sakta hai.)
 *  - Dropped (mempool se gayab) payments gine hi nahi jaate.
 */
export function evaluate(order: OrderView, payments: PaymentView[], now: Date, minConf: number): Decision {
  const live = payments.filter((p) => !p.dropped);
  const confirmed = live.filter((p) => p.confirmations >= minConf);
  const receivedConfirmed = sum(confirmed);
  const onTime = (p: PaymentView) => p.firstSeenAt.getTime() <= order.expiresAt.getTime();
  const onTimeAll = sum(live.filter(onTime));
  const onTimeConfirmed = sum(confirmed.filter(onTime));
  const funded = onTimeAll >= order.amountZats;
  const excess = receivedConfirmed > order.amountZats ? receivedConfirmed - order.amountZats : 0n;

  if (order.status === "paid" || order.status === "minted") {
    return { status: order.status, receivedZats: receivedConfirmed, refundDueZats: excess, funded: true };
  }
  if (order.status === "refunded") {
    throw new Error("refunded orders evaluate nahi hote");
  }

  if (order.status === "refund_needed") {
    // Sticky: ek baar refund_needed ho gaya to wapas "paid" nahi hoga
    // (jaise mint ke waqt supply ki problem nikli ho to loop na bane).
    return { status: "refund_needed", receivedZats: receivedConfirmed, refundDueZats: receivedConfirmed, funded: false };
  }

  if (onTimeConfirmed >= order.amountZats) {
    return { status: "paid", receivedZats: receivedConfirmed, refundDueZats: excess, funded: true };
  }

  if (now.getTime() > order.expiresAt.getTime()) {
    if (funded) {
      // Poora paisa time pe dikha tha, bas confirmations baaki hain: intezaar
      return { status: "pending", receivedZats: receivedConfirmed, refundDueZats: 0n, funded: true };
    }
    if (receivedConfirmed > 0n) {
      return { status: "refund_needed", receivedZats: receivedConfirmed, refundDueZats: receivedConfirmed, funded: false };
    }
    return { status: "expired", receivedZats: 0n, refundDueZats: 0n, funded: false };
  }

  return { status: "pending", receivedZats: receivedConfirmed, refundDueZats: 0n, funded };
}
