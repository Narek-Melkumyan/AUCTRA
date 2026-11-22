import { useState, type ImgHTMLAttributes } from "react";
import type { Photo } from "@/lib/media";
import { cn } from "@/lib/utils";

export type ImageSize = "thumb" | "card" | "full";

/**
 * Renders one listing photo at the smallest variant that fits.
 *
 * Uploaded photos have three WebP variants (320 / 800 / 1600 px, never upscaled). `size`
 * picks the default `src`; when the variants' real widths are known a `srcset` lets the
 * browser choose, guided by `sizes`, so a 56 px preview never downloads the 1600 px file.
 * Width/height come from the stored image so the layout does not shift while loading.
 * If the file cannot be loaded (e.g. the object was removed) a neutral placeholder is shown
 * instead of the browser's broken-image icon.
 */
export function AuctionImage({
  photo,
  size,
  sizes,
  alt,
  eager = false,
  ...rest
}: {
  photo: Photo | undefined;
  size: ImageSize;
  sizes?: string;
  alt: string;
  eager?: boolean;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "srcSet" | "alt" | "sizes">) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (!photo || failedSrc === photo[size])
    return (
      <div
        role={photo && alt ? "img" : undefined}
        aria-label={photo && alt ? alt : undefined}
        aria-hidden={photo && alt ? undefined : true}
        className={cn(rest.className, "bg-muted")}
      />
    );
  // Small originals produce variants of equal width; list each width once (smallest file).
  const seen = new Set<number>();
  const srcSet = photo.widths
    ? (["thumb", "card", "full"] as const)
        .filter((k) => !seen.has(photo.widths![k]) && seen.add(photo.widths![k]))
        .map((k) => `${photo[k]} ${photo.widths![k]}w`)
        .join(", ")
    : undefined;
  return (
    <img
      src={photo[size]}
      srcSet={srcSet}
      sizes={srcSet ? (sizes ?? DEFAULT_SIZES[size]) : undefined}
      alt={alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      width={photo.width}
      height={photo.height}
      // Third-party photos carry their attribution as a tooltip wherever they appear.
      title={
        photo.credit
          ? `Photo: ${photo.credit.author ?? "Unknown"} · ${photo.credit.license} · Wikimedia Commons`
          : undefined
      }
      {...rest}
      onError={(e) => {
        setFailedSrc(photo[size]);
        rest.onError?.(e);
      }}
    />
  );
}

const DEFAULT_SIZES: Record<ImageSize, string> = {
  thumb: "96px",
  card: "(min-width: 1024px) 400px, (min-width: 640px) 50vw, 100vw",
  full: "(min-width: 1024px) 60vw, 100vw",
};
