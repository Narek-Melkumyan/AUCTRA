import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ImageOff,
  ImagePlus,
  Loader2,
  RefreshCw,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { ApiError } from "@/lib/api/client";
import { toPhoto } from "@/lib/api/adapters";
import { ACCEPT_ATTR, MAX_IMAGES, checkFile, listingsApi } from "@/lib/api/listings";
import type { ImageDto } from "@/lib/api/types";
import { cn } from "@/lib/utils";

type QueueItem = {
  key: string;
  file: File;
  preview: string;
  progress: number;
  state: "queued" | "uploading" | "processing" | "error";
  error?: string;
  /** Network/server errors can succeed on retry; validation errors cannot. */
  retryable?: boolean;
  /** The browser could not render a preview (e.g. the file is not an image). */
  noPreview?: boolean;
};

// One at a time: the server appends each photo when it commits, so parallel uploads would
// finish (and be ordered) by speed rather than in the order the seller picked them — the
// first photo chosen must become the cover. Sequential uploads also share the seller's
// uplink better and keep server-side image processing load predictable.
const PARALLEL_UPLOADS = 1;
const kb = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
const message = (err: unknown) => (err instanceof ApiError ? err.message : "Something went wrong.");

/**
 * Photo manager for a draft listing. Every action goes to the AUCTRA API; the gallery
 * shown is always the server's answer, so nothing appears "uploaded" unless it was stored.
 */
export function ListingPhotos({
  auctionId,
  onChange,
}: {
  auctionId: string;
  onChange?: (images: ImageDto[]) => void;
}) {
  const [images, setImagesState] = useState<ImageDto[] | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const replaceTarget = useRef<string | null>(null);
  const active = useRef(0);

  const setImages = useCallback(
    (next: ImageDto[]) => {
      setImagesState(next);
      onChange?.(next);
    },
    [onChange],
  );

  useEffect(() => {
    let alive = true;
    listingsApi
      .images(auctionId)
      .then((list) => alive && setImages(list))
      .catch((err: unknown) => alive && setLoadError(message(err)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auctionId]);

  // Release object URLs for previews that are no longer shown.
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const live = new Set(queue.map((q) => q.preview));
    for (const url of previews.current)
      if (!live.has(url)) {
        URL.revokeObjectURL(url);
        previews.current.delete(url);
      }
    for (const url of live) previews.current.add(url);
  }, [queue]);
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const patch = (key: string, p: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...p } : it)));

  // Starts queued uploads, at most PARALLEL_UPLOADS at a time. Side effects stay out of
  // state updaters (React may run those twice); `started` guards against double starts.
  const started = useRef(new Set<string>());
  useEffect(() => {
    const free = PARALLEL_UPLOADS - active.current;
    if (free <= 0) return;
    const next = queue
      .filter((q) => q.state === "queued" && !started.current.has(q.key))
      .slice(0, free);
    for (const item of next) {
      started.current.add(item.key);
      active.current++;
      patch(item.key, { state: "uploading", progress: 0 });
      void listingsApi
        .uploadImage(auctionId, item.file, (f) =>
          patch(item.key, { progress: f, state: f >= 1 ? "processing" : "uploading" }),
        )
        .then((res) => {
          setImages(res.images);
          setQueue((cur) => cur.filter((it) => it.key !== item.key));
        })
        .catch((err: unknown) =>
          patch(item.key, {
            state: "error",
            error: message(err),
            retryable:
              !(err instanceof ApiError) ||
              err.status === 0 ||
              err.status >= 500 ||
              err.status === 429,
          }),
        )
        .finally(() => {
          active.current--;
          started.current.delete(item.key);
          // Re-render so the effect can start the next queued file.
          setQueue((cur) => [...cur]);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue, auctionId]);

  const add = (files: FileList | File[]) => {
    const list = Array.from(files);
    const pending = queue.filter((q) => q.state !== "error").length;
    const room = MAX_IMAGES - (images?.length ?? 0) - pending;
    const errors: string[] = [];
    const accepted: QueueItem[] = [];
    for (const file of list) {
      const problem = checkFile(file);
      if (problem) errors.push(problem);
      else if (accepted.length >= room)
        errors.push(`${file.name}: a listing can have at most ${MAX_IMAGES} photos.`);
      else
        accepted.push({
          key: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
          file,
          preview: URL.createObjectURL(file),
          progress: 0,
          state: "queued",
        });
    }
    if (errors.length) toast.error(errors.slice(0, 3).join("\n"));
    if (accepted.length) setQueue((q) => [...q, ...accepted]);
  };

  const run = async (label: string, fn: () => Promise<ImageDto[]>) => {
    setBusy(label);
    try {
      setImages(await fn());
    } catch (err) {
      toast.error(message(err));
    } finally {
      setBusy(null);
    }
  };

  const move = (id: string, to: number) => {
    if (!images) return;
    const order = images.map((i) => i.id).filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
    if (order.join() === images.map((i) => i.id).join()) return;
    void run(`move:${id}`, () => listingsApi.reorder(auctionId, order));
  };

  const replace = async (file: File) => {
    const id = replaceTarget.current;
    replaceTarget.current = null;
    if (!id) return;
    const problem = checkFile(file);
    if (problem) return void toast.error(problem);
    setBusy(`replace:${id}`);
    try {
      const res = await listingsApi.replaceImage(auctionId, id, file);
      setImages(res.images);
      toast.success("Photo replaced.");
    } catch (err) {
      // The original photo is untouched when a replacement fails.
      toast.error(message(err));
    } finally {
      setBusy(null);
    }
  };

  const full = (images?.length ?? 0) >= MAX_IMAGES;

  return (
    <div className="space-y-5">
      <div
        onDragOver={(e) => {
          if (dragId || full) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          if (dragId || full) return;
          e.preventDefault();
          setDragOver(false);
          add(e.dataTransfer.files);
        }}
        className={cn(
          "rounded-lg border border-dashed p-6 text-center transition",
          dragOver && "border-foreground bg-accent",
          full && "opacity-60",
        )}
      >
        <Upload className="mx-auto size-7 text-muted-foreground" aria-hidden />
        <p className="mt-3 text-sm font-medium">
          {full ? `Photo limit reached (${MAX_IMAGES})` : "Drag photos here or"}
        </p>
        {!full && (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="mt-3 inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-accent"
          >
            <ImagePlus className="size-4" />
            Choose photos
          </button>
        )}
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT_ATTR}
          multiple
          className="sr-only"
          aria-label="Choose photos to upload"
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
          }}
        />
        <input
          ref={replaceRef}
          type="file"
          accept={ACCEPT_ATTR}
          className="sr-only"
          aria-label="Choose a replacement photo"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void replace(f);
          }}
        />
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          JPEG, PNG, WebP or AVIF · up to 10 MB each · at least 100×100 px · up to {MAX_IMAGES}{" "}
          photos. Photos are converted to WebP and location metadata is removed.
        </p>
      </div>

      {loadError && (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      )}

      {queue.length > 0 && (
        <ul className="space-y-2" aria-label="Uploads in progress">
          {queue.map((q) => (
            <li key={q.key} className="flex items-center gap-3 rounded-lg border bg-card p-2">
              {q.noPreview ? (
                <div className="grid size-12 shrink-0 place-items-center rounded-md bg-muted">
                  <ImageOff className="size-4 text-muted-foreground" aria-hidden />
                </div>
              ) : (
                <img
                  src={q.preview}
                  alt=""
                  onError={() => patch(q.key, { noPreview: true })}
                  className="size-12 shrink-0 rounded-md object-cover"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{q.file.name}</p>
                {q.state === "error" ? (
                  <p className="text-xs text-destructive">{q.error}</p>
                ) : (
                  <>
                    <div
                      className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={Math.round(q.progress * 100)}
                      aria-label={`Uploading ${q.file.name}`}
                    >
                      <div
                        className="h-full rounded-full bg-primary transition-[width]"
                        style={{ width: `${Math.round(q.progress * 100)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {q.state === "queued"
                        ? "Waiting…"
                        : q.state === "processing"
                          ? "Optimising…"
                          : `Uploading ${Math.round(q.progress * 100)}% · ${kb(q.file.size)}`}
                    </p>
                  </>
                )}
              </div>
              {q.state === "error" && q.retryable && (
                <button
                  type="button"
                  onClick={() => patch(q.key, { state: "queued", progress: 0 })}
                  className="grid size-8 place-items-center rounded-md hover:bg-accent"
                  aria-label={`Retry ${q.file.name}`}
                >
                  <RefreshCw className="size-4" />
                </button>
              )}
              {(q.state === "error" || q.state === "queued") && (
                <button
                  type="button"
                  onClick={() => setQueue((cur) => cur.filter((it) => it.key !== q.key))}
                  className="grid size-8 place-items-center rounded-md hover:bg-accent"
                  aria-label={`Remove ${q.file.name} from the queue`}
                >
                  <X className="size-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {images === null && !loadError ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="aspect-[4/3] animate-pulse rounded-lg bg-muted" />
          ))}
        </div>
      ) : images && images.length > 0 ? (
        <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="Listing photos">
          {images.map((img, i) => {
            const working = busy?.endsWith(img.id);
            return (
              <li
                key={img.id}
                draggable={!busy}
                onDragStart={() => setDragId(img.id)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => dragId && e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId && dragId !== img.id) move(dragId, i);
                  setDragId(null);
                }}
                className={cn(
                  "group relative overflow-hidden rounded-lg border bg-card",
                  dragId === img.id && "opacity-50",
                )}
              >
                <AuctionImage
                  photo={toPhoto(img, "")}
                  size="thumb"
                  sizes="(min-width: 640px) 220px, 45vw"
                  alt={img.altText ?? `Photo ${i + 1}`}
                  className="aspect-[4/3] w-full object-cover"
                />
                {img.isPrimary && (
                  <span className="absolute left-2 top-2 rounded bg-background/90 px-2 py-0.5 text-[11px] font-medium">
                    Cover
                  </span>
                )}
                {working && (
                  <div className="absolute inset-0 grid place-items-center bg-background/60">
                    <Loader2 className="size-5 animate-spin" aria-label="Working" />
                  </div>
                )}
                <div className="flex items-center justify-between gap-1 border-t p-1.5">
                  <span
                    className="truncate px-1 text-[11px] tabular-nums text-muted-foreground"
                    title={
                      img.variants
                        ? `Stored as WebP: ${img.variants.full.width}×${img.variants.full.height}, ${kb(img.variants.full.bytes)} (full) · ${kb(img.variants.card.bytes)} (card) · ${kb(img.variants.thumbnail.bytes)} (thumbnail)`
                        : "Bundled demo image"
                    }
                  >
                    {img.variants
                      ? `${img.variants.full.width}×${img.variants.full.height}`
                      : "Demo image"}
                  </span>
                  <div className="flex shrink-0">
                    <IconButton
                      label="Move earlier"
                      disabled={!!busy || i === 0}
                      onClick={() => move(img.id, i - 1)}
                    >
                      <ArrowLeft className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label="Move later"
                      disabled={!!busy || i === images.length - 1}
                      onClick={() => move(img.id, i + 1)}
                    >
                      <ArrowRight className="size-3.5" />
                    </IconButton>
                    <IconButton
                      label="Set as cover"
                      disabled={!!busy || img.isPrimary}
                      onClick={() =>
                        void run(`primary:${img.id}`, () =>
                          listingsApi.setPrimary(auctionId, img.id),
                        )
                      }
                    >
                      <Star className={cn("size-3.5", img.isPrimary && "fill-current")} />
                    </IconButton>
                    <IconButton
                      label="Replace photo"
                      disabled={!!busy}
                      onClick={() => {
                        replaceTarget.current = img.id;
                        replaceRef.current?.click();
                      }}
                    >
                      <RefreshCw className="size-3.5" />
                    </IconButton>
                    {confirmRemove === img.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmRemove(null);
                          void run(`remove:${img.id}`, () =>
                            listingsApi.removeImage(auctionId, img.id),
                          );
                        }}
                        className="h-7 rounded px-2 text-[11px] font-medium text-destructive hover:bg-accent"
                      >
                        Remove?
                      </button>
                    ) : (
                      <IconButton
                        label="Remove photo"
                        disabled={!!busy}
                        onClick={() => setConfirmRemove(img.id)}
                      >
                        <Trash2 className="size-3.5" />
                      </IconButton>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        images && (
          <p className="text-sm text-muted-foreground">
            No photos yet. The first photo you add becomes the cover.
          </p>
        )
      )}
    </div>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded hover:bg-accent disabled:pointer-events-none disabled:opacity-35"
    >
      {children}
    </button>
  );
}
