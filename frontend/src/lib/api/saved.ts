/**
 * Address book and favourites (API mode). Both are stored server-side per user:
 * GET/POST/PATCH/DELETE /me/addresses and GET/PUT/DELETE /me/favorites/:auctionId.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/demo-session";
import { IS_API_MODE } from "@/lib/auction-store";
import { api, ApiError } from "./client";
import type { AuctionDto } from "./types";

export type AddressType = "SHIPPING" | "BILLING" | "PICKUP";

export type SavedAddress = {
  id: string;
  type: AddressType;
  label: string | null;
  fullName: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string | null;
  country: string;
  phone: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type AddressInput = {
  type: AddressType;
  label?: string;
  fullName: string;
  line1: string;
  line2?: string;
  city: string;
  region?: string;
  postalCode?: string;
  country: string;
  phone?: string;
  isDefault?: boolean;
};

export const ADDRESS_TYPES: { value: AddressType; label: string }[] = [
  { value: "SHIPPING", label: "Shipping" },
  { value: "BILLING", label: "Billing" },
  { value: "PICKUP", label: "Pickup" },
];

/** Drops blank optional fields so the server stores NULL instead of empty strings. */
export function cleanAddress(a: AddressInput): AddressInput {
  const out: AddressInput = {
    type: a.type,
    fullName: a.fullName.trim(),
    line1: a.line1.trim(),
    city: a.city.trim(),
    country: a.country.trim().toUpperCase(),
    isDefault: Boolean(a.isDefault),
  };
  for (const k of ["label", "line2", "region", "postalCode", "phone"] as const) {
    const v = a[k]?.trim();
    if (v) out[k] = v;
  }
  return out;
}

/** Client-side checks mirroring the server's validation, for immediate feedback. */
export function addressProblems(a: AddressInput): Partial<Record<keyof AddressInput, string>> {
  const p: Partial<Record<keyof AddressInput, string>> = {};
  if (!a.fullName.trim()) p.fullName = "Enter the recipient's name.";
  if (!a.line1.trim()) p.line1 = "Enter the street address.";
  if (!a.city.trim()) p.city = "Enter the city.";
  if (!/^[A-Z]{2}$/.test(a.country.trim().toUpperCase())) p.country = "Choose a country.";
  if (a.phone?.trim() && !/^\+?[0-9 ()-]{0,32}$/.test(a.phone.trim()))
    p.phone = "Use digits, spaces, brackets or dashes only.";
  return p;
}

export const addressesApi = {
  list: () => api<SavedAddress[]>("/me/addresses"),
  create: (body: AddressInput) =>
    api<SavedAddress>("/me/addresses", { method: "POST", body: cleanAddress(body) }),
  /** Full edit: optional fields left blank are cleared (sent as null). */
  update: (id: string, body: AddressInput) => {
    const clean = cleanAddress(body);
    const cleared = Object.fromEntries(
      (["label", "line2", "region", "postalCode", "phone"] as const)
        .filter((k) => clean[k] === undefined)
        .map((k) => [k, null]),
    );
    return api<SavedAddress>(`/me/addresses/${id}`, {
      method: "PATCH",
      body: { ...clean, ...cleared },
    });
  },
  /** Small change, e.g. { isDefault: true }. */
  patch: (id: string, body: Partial<AddressInput>) =>
    api<SavedAddress>(`/me/addresses/${id}`, { method: "PATCH", body }),
  remove: (id: string) => api<void>(`/me/addresses/${id}`, { method: "DELETE" }),
};

export const favoritesApi = {
  list: () => api<{ auctionId: string; createdAt: string }[]>("/me/favorites"),
  add: (auctionId: string) => api(`/me/favorites/${auctionId}`, { method: "PUT", body: {} }),
  remove: (auctionId: string) => api<void>(`/me/favorites/${auctionId}`, { method: "DELETE" }),
};

const ADDRESSES = ["me", "addresses"] as const;
const FAVORITES = ["me", "favorites"] as const;

export function useAddresses() {
  const user = useSession((s) => s.user);
  return useQuery({
    queryKey: [...ADDRESSES, user?.id],
    queryFn: addressesApi.list,
    enabled: IS_API_MODE && Boolean(user),
  });
}

export function useAddressMutations() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries({ queryKey: ADDRESSES });
  return {
    create: useMutation({ mutationFn: addressesApi.create, onSuccess: done }),
    update: useMutation({
      mutationFn: ({ id, body }: { id: string; body: AddressInput }) =>
        addressesApi.update(id, body),
      onSuccess: done,
    }),
    makeDefault: useMutation({
      mutationFn: (id: string) => addressesApi.patch(id, { isDefault: true }),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: addressesApi.remove, onSuccess: done }),
  };
}

/** IDs of my favourite lots, newest first. */
export function useFavoriteIds() {
  const user = useSession((s) => s.user);
  return useQuery({
    queryKey: [...FAVORITES, user?.id],
    queryFn: favoritesApi.list,
    enabled: IS_API_MODE && Boolean(user),
    select: (items) => items.map((i) => i.auctionId),
  });
}

/**
 * Full listings for my favourites. Lots that are no longer visible (withdrawn, deleted)
 * are skipped rather than failing the page.
 */
export function useFavoriteLots(ids: string[] | undefined) {
  return useQuery({
    queryKey: [...FAVORITES, "lots", ids],
    enabled: Boolean(ids?.length),
    queryFn: async () => {
      const res = await Promise.allSettled(
        (ids ?? []).slice(0, 100).map((id) => api<AuctionDto>(`/auctions/${id}`)),
      );
      return res.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    },
  });
}

/** Optimistic favourite toggle; reverts and reports when the server refuses. */
export function useToggleFavorite() {
  const qc = useQueryClient();
  const user = useSession((s) => s.user);
  const key = [...FAVORITES, user?.id];
  return useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) =>
      on ? favoritesApi.add(id) : favoritesApi.remove(id),
    onMutate: async ({ id, on }) => {
      await qc.cancelQueries({ queryKey: key });
      const prev = qc.getQueryData<{ auctionId: string; createdAt: string }[]>(key);
      qc.setQueryData(key, (cur: typeof prev) => {
        const rest = (cur ?? []).filter((f) => f.auctionId !== id);
        return on ? [{ auctionId: id, createdAt: new Date().toISOString() }, ...rest] : rest;
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => qc.setQueryData(key, ctx?.prev),
    onSettled: () => qc.invalidateQueries({ queryKey: FAVORITES }),
  });
}

export const errText = (err: unknown, fallback = "Something went wrong. Please try again.") =>
  err instanceof ApiError ? err.message : fallback;
