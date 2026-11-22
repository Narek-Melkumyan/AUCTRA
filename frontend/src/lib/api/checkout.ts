/** Simulated (demo) checkout — AUCTRA never collects card details or takes real payments. */
import { useQuery } from "@tanstack/react-query";
import { api } from "./client";
import type { OrderDto } from "./types";

export type Money = { minor: string; currency: string };
export type DeliveryKey = "PICKUP" | "INSURED_SHIPPING" | "WHITE_GLOVE" | "ARRANGED";

export type CheckoutSummary = {
  orderId: string;
  orderNumber: string;
  status: string;
  simulated: true;
  completed: boolean;
  demoCompletedAt: string | null;
  auction: {
    id: string;
    title: string;
    lotNumber: number;
    image: string | null;
    categorySlug: string;
    shippingNotes: string | null;
  };
  hammerPrice: Money;
  buyerPremium: Money;
  tax: Money;
  shipping: Money;
  total: Money;
  fulfillmentMethod: string | null;
  deliveryOptions: { key: DeliveryKey; label: string; price: Money; needsAddress: boolean }[];
};

export type Address = {
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
};

export type CheckoutTerms = {
  simulated: true;
  buyerPremiumBps: number;
  sellerCommissionBps: number;
  delivery: { key: DeliveryKey; label: string; priceMinor: string; needsAddress: boolean }[];
};

export const checkoutApi = {
  terms: () => api<CheckoutTerms>("/checkout-terms"),
  summary: (auctionId: string) => api<CheckoutSummary>(`/checkout/${auctionId}`),
  complete: (orderId: string, body: { delivery: DeliveryKey; address?: Address }, key: string) =>
    api<{ replayed: boolean; order: OrderDto & { demoCompletedAt: string | null } }>(
      `/orders/${orderId}/demo-checkout`,
      { method: "POST", body, headers: { "Idempotency-Key": key } },
    ),
};

/** Configured buyer premium (basis points) for fee previews; 0 until loaded. */
export function useCheckoutTerms(enabled = true) {
  return useQuery({
    queryKey: ["checkout-terms"],
    queryFn: checkoutApi.terms,
    staleTime: 5 * 60_000,
    enabled,
  });
}
