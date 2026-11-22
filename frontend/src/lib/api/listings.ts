/**
 * Seller listings and listing photos (API mode). Photos are uploaded to the AUCTRA API,
 * which validates them, converts them to WebP variants and stores them in Cloudflare R2.
 * The browser never sees storage credentials.
 */
import { api, uploadForm } from "./client";
import type { AuctionDto, ImageDto, MeDto } from "./types";

export type CategoryAttribute = {
  key: string;
  label: string;
  type: "TEXT" | "NUMBER" | "BOOLEAN" | "ENUM" | "DATE";
  required: boolean;
  options: string[] | null;
  unit: string | null;
};
export type CategoryNode = {
  slug: string;
  name: string;
  description: string | null;
  /** Live + scheduled public lots in this (sub)category, counted by PostgreSQL. */
  activeAuctionCount?: number;
  attributes: CategoryAttribute[];
  subcategories: Omit<CategoryNode, "subcategories">[];
};

export type ListingInput = {
  title: string;
  description: string;
  categorySlug: string;
  subcategorySlug?: string;
  condition: AuctionDto["condition"];
  conditionNotes?: string;
  locationCity?: string;
  locationCountry?: string;
  currency: string;
  startingPriceMinor: string;
  minIncrementMinor: string;
  reservePriceMinor?: string;
  buyNowPriceMinor?: string;
  startsAt: string;
  endsAt: string;
  fulfillmentMethod: "SHIPPING" | "PICKUP" | "ARRANGED";
  shippingNotes?: string;
  attributes?: { key: string; value: string | number | boolean | null }[];
  vehicle?: { make: string; model: string; year: number; mileageKm?: number };
  watch?: { brand: string; model: string; year?: number };
};

export type UploadResult = {
  images: ImageDto[];
  uploaded: ImageDto[];
  failed: { index: number; fileName: string; code: string; message: string }[];
};

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 12;
export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
export const ACCEPT_ATTR = ".jpg,.jpeg,.png,.webp,.avif,image/jpeg,image/png,image/webp,image/avif";

export const listingsApi = {
  categories: () => api<CategoryNode[]>("/categories"),
  mine: () => api<AuctionDto[]>("/me/auctions"),
  get: (id: string) => api<AuctionDto>(`/auctions/${id}`),
  create: (body: ListingInput) => api<AuctionDto>("/auctions", { method: "POST", body }),
  update: (id: string, body: Partial<ListingInput>) =>
    api<AuctionDto>(`/auctions/${id}`, { method: "PATCH", body }),
  submit: (id: string) => api<AuctionDto>(`/auctions/${id}/submit`, { method: "POST" }),
  withdraw: (id: string) => api<AuctionDto>(`/auctions/${id}/withdraw`, { method: "POST" }),
  applyAsSeller: (body: { type: "PRIVATE" | "DEALER"; businessName?: string }) =>
    api<MeDto>("/me/seller-application", { method: "POST", body }),

  images: (id: string) => api<ImageDto[]>(`/auctions/${id}/images`),
  uploadImage: (
    id: string,
    file: File,
    onProgress?: (fraction: number) => void,
    signal?: AbortSignal,
  ) => {
    const form = new FormData();
    form.append("images", file);
    return uploadForm<UploadResult>(`/auctions/${id}/images`, form, onProgress, signal);
  },
  replaceImage: (id: string, imageId: string, file: File, onProgress?: (f: number) => void) => {
    const form = new FormData();
    form.append("images", file);
    return uploadForm<{ images: ImageDto[]; image: ImageDto }>(
      `/auctions/${id}/images/${imageId}/replace`,
      form,
      onProgress,
    );
  },
  reorder: (id: string, imageIds: string[]) =>
    api<ImageDto[]>(`/auctions/${id}/images/reorder`, { method: "PATCH", body: { imageIds } }),
  setPrimary: (id: string, imageId: string) =>
    api<ImageDto[]>(`/auctions/${id}/images/${imageId}/primary`, { method: "PATCH" }),
  removeImage: (id: string, imageId: string) =>
    api<ImageDto[]>(`/auctions/${id}/images/${imageId}`, { method: "DELETE" }),
};

/** Client-side pre-check (the server re-validates the real image content). */
export function checkFile(file: File): string | null {
  const okType = ACCEPTED_TYPES.includes(file.type) || /\.(jpe?g|png|webp|avif)$/i.test(file.name);
  if (!okType) return `${file.name}: use a JPEG, PNG, WebP or AVIF image.`;
  if (file.size > MAX_UPLOAD_BYTES) return `${file.name}: images must be 10 MB or smaller.`;
  if (file.size === 0) return `${file.name}: the file is empty.`;
  return null;
}
