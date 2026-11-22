import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, ImageIcon, Loader2, Plus, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { AuctionImage } from "@/components/auction/AuctionImage";
import { ApiError, majorToMinor, minorToMajor } from "@/lib/api/client";
import { refreshMe } from "@/lib/api/account";
import { toPhoto } from "@/lib/api/adapters";
import {
  listingsApi,
  type CategoryAttribute,
  type CategoryNode,
  type ListingInput,
} from "@/lib/api/listings";
import type { AuctionDto, ImageDto } from "@/lib/api/types";
import type { Profile } from "@/lib/demo-session";
import { cn } from "@/lib/utils";
import { ListingPhotos } from "./ListingPhotos";

const inputClass =
  "h-11 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring";
const choiceClass = (active: boolean) =>
  cn(
    "rounded-md border px-4 py-3 text-left text-sm transition hover:bg-accent",
    active && "border-foreground bg-accent",
  );
const primaryBtn =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50";
const ghostBtn =
  "inline-flex h-10 items-center justify-center gap-2 rounded-md border px-5 text-sm font-medium hover:bg-accent disabled:opacity-50";

const errText = (err: unknown) =>
  err instanceof ApiError ? err.message : "Something went wrong. Please try again.";

const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "In review",
  SCHEDULED: "Scheduled",
  LIVE: "Live",
  ENDED: "Ended",
  SOLD: "Sold",
  UNSOLD: "Unsold",
  CANCELLED: "Cancelled",
};

// ───────────────────────── Workspace ─────────────────────────

/** Seller workspace backed by the AUCTRA API: real drafts, real photo uploads, real submission. */
export function SellerWorkspace({ user }: { user: Profile }) {
  const canSell = user.permissions?.includes("auction:create") ?? false;
  const [listings, setListings] = useState<AuctionDto[] | null>(null);
  const [editing, setEditing] = useState<{ draft: AuctionDto | null; step?: number } | null>(null);

  const load = useCallback(() => {
    if (!canSell) return;
    listingsApi
      .mine()
      .then(setListings)
      .catch((err: unknown) => {
        setListings([]);
        toast.error(errText(err));
      });
  }, [canSell]);
  useEffect(load, [load]);

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-16">
      <div className="flex flex-wrap items-end justify-between gap-5 border-b pb-7">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            Seller workspace
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Welcome, {user.name}
          </h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            Create listings, upload photos and submit them for review.
          </p>
        </div>
        {canSell && !editing && (
          <button type="button" onClick={() => setEditing({ draft: null })} className={primaryBtn}>
            <Plus className="size-4" />
            Create listing
          </button>
        )}
      </div>

      {!canSell ? (
        <SellerApplication />
      ) : editing ? (
        <ListingWizard
          key={editing.draft?.id ?? "new"}
          draft={editing.draft}
          {...(editing.step === undefined ? {} : { initialStep: editing.step })}
          onClose={() => {
            setEditing(null);
            load();
          }}
        />
      ) : (
        <ListingsList
          listings={listings}
          onEdit={(draft, step) => setEditing({ draft, ...(step === undefined ? {} : { step }) })}
          onCreate={() => setEditing({ draft: null })}
          onChanged={load}
        />
      )}
    </main>
  );
}

function ListingsList({
  listings,
  onEdit,
  onCreate,
  onChanged,
}: {
  listings: AuctionDto[] | null;
  onEdit: (draft: AuctionDto, step?: number) => void;
  onCreate: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  if (listings === null)
    return (
      <div className="mt-8 space-y-3">
        {[0, 1].map((i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-muted/50" />
        ))}
      </div>
    );
  if (!listings.length)
    return (
      <section className="mt-8 rounded-xl border bg-card p-7 sm:p-10">
        <div className="grid size-12 place-items-center rounded-lg bg-secondary">
          <Plus className="size-6 text-muted-foreground" />
        </div>
        <h2 className="mt-6 text-xl font-semibold">Your listings</h2>
        <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
          You have no listings yet. Drafts are saved to your account; nothing goes live until AUCTRA
          reviews and approves it.
        </p>
        <button type="button" onClick={onCreate} className={cn(ghostBtn, "mt-6")}>
          Create your first listing
        </button>
      </section>
    );
  const withdraw = async (a: AuctionDto) => {
    setBusy(a.id);
    try {
      await listingsApi.withdraw(a.id);
      toast.success("Moved back to draft. You can edit it now.");
      onChanged();
    } catch (err) {
      toast.error(errText(err));
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mt-8">
      <h2 className="text-base font-semibold">Your listings</h2>
      <ul className="mt-4 divide-y overflow-hidden rounded-xl border bg-card">
        {listings.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-4 p-4">
            <AuctionImage
              photo={a.media[0] ? toPhoto(a.media[0], a.category.slug) : undefined}
              size="thumb"
              sizes="64px"
              alt=""
              className="size-16 shrink-0 rounded-md object-cover"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">{a.title}</p>
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 font-medium",
                    a.status === "DRAFT" ? "bg-secondary" : "bg-primary/10 text-foreground",
                  )}
                >
                  {STATUS_LABEL[a.status] ?? a.status}
                </span>
                <span className="inline-flex items-center gap-1">
                  <ImageIcon className="size-3.5" /> {a.media.length} photo
                  {a.media.length === 1 ? "" : "s"}
                </span>
                <span>{a.category.name}</span>
              </p>
            </div>
            <div className="flex gap-2">
              {a.status === "DRAFT" && (
                <>
                  <button type="button" className={ghostBtn} onClick={() => onEdit(a, PHOTOS_STEP)}>
                    Photos
                  </button>
                  <button type="button" className={primaryBtn} onClick={() => onEdit(a)}>
                    Continue
                  </button>
                </>
              )}
              {a.status === "PENDING_REVIEW" && (
                <button
                  type="button"
                  className={ghostBtn}
                  disabled={busy === a.id}
                  onClick={() => void withdraw(a)}
                >
                  Withdraw to edit
                </button>
              )}
              {["SCHEDULED", "LIVE", "ENDED", "SOLD", "UNSOLD"].includes(a.status) && (
                <Link
                  to={a.status === "LIVE" ? "/room/$id" : "/item/$id"}
                  params={{ id: a.id }}
                  className={ghostBtn}
                >
                  View
                </Link>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SellerApplication() {
  const [type, setType] = useState<"PRIVATE" | "DEALER">("PRIVATE");
  const [businessName, setBusinessName] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");
  const submit = async () => {
    setError("");
    setState("busy");
    try {
      await listingsApi.applyAsSeller({
        type,
        ...(type === "DEALER" ? { businessName: businessName.trim() } : {}),
      });
      await refreshMe();
      setState("sent");
    } catch (err) {
      if (err instanceof ApiError && err.code === "APPLICATION_PENDING") setState("sent");
      else {
        setError(errText(err));
        setState("idle");
      }
    }
  };
  return (
    <section className="mx-auto mt-10 max-w-xl rounded-xl border bg-card p-6 sm:p-8">
      <ShieldCheck className="size-7 text-muted-foreground" aria-hidden />
      <h2 className="mt-4 text-xl font-semibold">Seller account required</h2>
      {state === "sent" ? (
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          Your seller application is with the AUCTRA team. You can create listings once an
          administrator verifies your account.
        </p>
      ) : (
        <>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            Listings can only be created by verified sellers. Apply below; an administrator reviews
            every application.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            {(["PRIVATE", "DEALER"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={choiceClass(type === t)}
                onClick={() => setType(t)}
              >
                {t === "PRIVATE" ? "Private seller" : "Dealer / business"}
              </button>
            ))}
          </div>
          {type === "DEALER" && (
            <label className="mt-3 block text-sm">
              Business name
              <input
                className={cn(inputClass, "mt-1.5")}
                value={businessName}
                onChange={(e) => setBusinessName(e.target.value)}
              />
            </label>
          )}
          {error && (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="button"
            className={cn(primaryBtn, "mt-5")}
            disabled={state === "busy" || (type === "DEALER" && businessName.trim().length < 2)}
            onClick={() => void submit()}
          >
            {state === "busy" && <Loader2 className="size-4 animate-spin" />}
            Apply to sell
          </button>
        </>
      )}
    </section>
  );
}

// ───────────────────────── Wizard ─────────────────────────

const STEPS = [
  "Category",
  "Item details",
  "Condition",
  "Pricing",
  "Schedule",
  "Delivery",
  "Photos",
  "Review",
] as const;
const PHOTOS_STEP = 6;

const CONDITIONS: [AuctionDto["condition"], string][] = [
  ["NEW", "New"],
  ["EXCELLENT", "Excellent"],
  ["VERY_GOOD", "Very good"],
  ["GOOD", "Good"],
  ["FAIR", "Fair"],
  ["POOR", "Poor"],
];
const FULFILLMENT: [ListingInput["fulfillmentMethod"], string, string][] = [
  ["SHIPPING", "Seller ships", "You ship the item to the buyer."],
  ["PICKUP", "Buyer pickup", "The buyer collects the item."],
  ["ARRANGED", "Arranged", "Delivery is arranged after the sale."],
];

type Form = {
  categorySlug: string;
  subcategorySlug: string;
  title: string;
  description: string;
  attrs: Record<string, string>;
  make: string;
  model: string;
  year: string;
  mileage: string;
  brand: string;
  condition: AuctionDto["condition"] | "";
  conditionNotes: string;
  start: string;
  increment: string;
  reserve: string;
  buyNow: string;
  startAt: string;
  endAt: string;
  fulfillment: ListingInput["fulfillmentMethod"] | "";
  shippingNotes: string;
  city: string;
};

/** ISO → value for <input type="datetime-local"> in the user's time zone. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const major = (m: { minor: string; currency: string } | null | undefined) =>
  m ? String(minorToMajor(m.minor, m.currency)) : "";

function formFrom(a: AuctionDto | null): Form {
  const attrs: Record<string, string> = {};
  for (const x of a?.attributes ?? []) if (x.value !== null) attrs[x.key] = String(x.value);
  const v = a?.vehicle ?? null;
  const w = a?.watch ?? null;
  const now = Date.now();
  return {
    categorySlug: a?.category.slug ?? "",
    subcategorySlug: a?.subcategory?.slug ?? "",
    title: a?.title ?? "",
    description: a?.description ?? "",
    attrs,
    make: String(v?.["make"] ?? ""),
    model: String(v?.["model"] ?? w?.["model"] ?? ""),
    year: String(v?.["year"] ?? w?.["year"] ?? ""),
    mileage: v?.["mileageKm"] == null ? "" : String(v["mileageKm"]),
    brand: String(w?.["brand"] ?? ""),
    condition: a?.condition ?? "",
    conditionNotes: a?.conditionNotes ?? "",
    start: major(a?.startingPrice),
    increment: major(a?.minIncrement),
    reserve: major(a?.reservePrice),
    buyNow: major(a?.buyNowPrice),
    startAt: toLocalInput(a?.startsAt ?? new Date(now + 86_400_000).toISOString()),
    endAt: toLocalInput(a?.endsAt ?? new Date(now + 8 * 86_400_000).toISOString()),
    fulfillment: a?.fulfillmentMethod ?? "",
    shippingNotes: a?.shippingNotes ?? "",
    city: a?.location.city ?? "",
  };
}

/** A sensible default bid increment for a starting price (the seller can change it). */
function suggestIncrement(start: number): string {
  if (!(start > 0)) return "";
  if (start < 1_000) return "10";
  if (start < 10_000) return "50";
  if (start < 100_000) return "250";
  return "1000";
}

function ListingWizard({
  draft: initialDraft,
  initialStep = 0,
  onClose,
}: {
  draft: AuctionDto | null;
  initialStep?: number;
  onClose: () => void;
}) {
  const [step, setStep] = useState(initialStep);
  const [draft, setDraft] = useState<AuctionDto | null>(initialDraft);
  const [form, setForm] = useState<Form>(() => formFrom(initialDraft));
  const [dirty, setDirty] = useState(false);
  const [categories, setCategories] = useState<CategoryNode[] | null>(null);
  const [photos, setPhotos] = useState<ImageDto[]>(initialDraft?.media ?? []);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState<AuctionDto | null>(null);

  useEffect(() => {
    listingsApi
      .categories()
      .then(setCategories)
      .catch((err: unknown) => setError(errText(err)));
  }, []);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [k]: v }));
  };

  const category = categories?.find((c) => c.slug === form.categorySlug);
  const sub = category?.subcategories.find((s) => s.slug === form.subcategorySlug);
  const allAttrs: CategoryAttribute[] = useMemo(
    () => [...(category?.attributes ?? []), ...(sub?.attributes ?? [])],
    [category, sub],
  );
  const requiredAttrs = allAttrs.filter((a) => a.required);
  const isCar = form.categorySlug === "cars";
  const isWatch = form.categorySlug === "watches";

  const validate = (): string => {
    switch (step) {
      case 0:
        if (!form.categorySlug) return "Choose a category.";
        if (category?.subcategories.length && !form.subcategorySlug) return "Choose a subcategory.";
        return "";
      case 1:
        if (form.title.trim().length < 5) return "Title must be at least 5 characters.";
        if (form.description.trim().length < 20)
          return "Description must be at least 20 characters.";
        for (const a of requiredAttrs)
          if (!form.attrs[a.key]?.trim()) return `Enter ${a.label.toLowerCase()}.`;
        if (isCar && (!form.make.trim() || !form.model.trim() || !/^\d{4}$/.test(form.year)))
          return "Enter the vehicle's make, model and year.";
        if (isWatch && (!form.brand.trim() || !form.model.trim()))
          return "Enter the watch's brand and model.";
        return "";
      case 2:
        return form.condition ? "" : "Select a condition.";
      case 3: {
        const start = Number(form.start);
        if (!(start > 0)) return "Enter a starting bid.";
        if (!(Number(form.increment) > 0)) return "Enter a minimum bid increment.";
        if (form.reserve && Number(form.reserve) < start)
          return "Reserve cannot be below the starting bid.";
        if (form.buyNow && Number(form.buyNow) <= start)
          return "Buy-now price must be above the starting bid.";
        return "";
      }
      case 4: {
        const s = new Date(form.startAt).getTime();
        const e = new Date(form.endAt).getTime();
        if (!Number.isFinite(s) || !Number.isFinite(e)) return "Choose both auction times.";
        if (e - s < 60_000) return "The auction must run for at least one minute.";
        if (e - s > 90 * 86_400_000) return "An auction can run for at most 90 days.";
        if (e <= Date.now()) return "The end time must be in the future.";
        return "";
      }
      case 5:
        return form.fulfillment ? "" : "Choose a delivery option.";
      case 6:
        return photos.length ? "" : "Add at least one photo.";
      default:
        return "";
    }
  };

  const payload = (): ListingInput => {
    // Every attribute that has a value (required ones are always filled by validation);
    // sending the full set keeps optional values set earlier when a draft is edited.
    const attributes = allAttrs
      .filter((a) => (form.attrs[a.key] ?? "").trim() !== "")
      .map((a) => {
        const raw = form.attrs[a.key]!.trim();
        return {
          key: a.key,
          value: a.type === "NUMBER" ? Number(raw) : a.type === "BOOLEAN" ? raw === "true" : raw,
        };
      });
    return {
      title: form.title.trim(),
      description: form.description.trim(),
      categorySlug: form.categorySlug,
      ...(form.subcategorySlug ? { subcategorySlug: form.subcategorySlug } : {}),
      condition: form.condition as AuctionDto["condition"],
      ...(form.conditionNotes.trim() ? { conditionNotes: form.conditionNotes.trim() } : {}),
      ...(form.city.trim() ? { locationCity: form.city.trim() } : {}),
      currency: "USD",
      startingPriceMinor: majorToMinor(Number(form.start)),
      minIncrementMinor: majorToMinor(Number(form.increment)),
      ...(form.reserve ? { reservePriceMinor: majorToMinor(Number(form.reserve)) } : {}),
      ...(form.buyNow ? { buyNowPriceMinor: majorToMinor(Number(form.buyNow)) } : {}),
      startsAt: new Date(form.startAt).toISOString(),
      endsAt: new Date(form.endAt).toISOString(),
      fulfillmentMethod: form.fulfillment as ListingInput["fulfillmentMethod"],
      ...(form.shippingNotes.trim() ? { shippingNotes: form.shippingNotes.trim() } : {}),
      ...(attributes.length ? { attributes } : {}),
      ...(isCar
        ? {
            vehicle: {
              make: form.make.trim(),
              model: form.model.trim(),
              year: Number(form.year),
              ...(form.mileage ? { mileageKm: Number(form.mileage) } : {}),
            },
          }
        : {}),
      ...(isWatch
        ? {
            watch: {
              brand: form.brand.trim(),
              model: form.model.trim(),
              ...(/^\d{4}$/.test(form.year) ? { year: Number(form.year) } : {}),
            },
          }
        : {}),
    };
  };

  /** Creates the draft (or saves edits) on the server. Photos need a saved draft. */
  const save = async (): Promise<boolean> => {
    if (draft && !dirty) return true;
    setSaving(true);
    try {
      const saved = draft
        ? await listingsApi.update(draft.id, payload())
        : await listingsApi.create(payload());
      setDraft(saved);
      setDirty(false);
      if (!draft) toast.success("Draft saved to your account.");
      return true;
    } catch (err) {
      setError(errText(err));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const next = async () => {
    const message = validate();
    setError(message);
    if (message) return;
    if (step === PHOTOS_STEP - 1 && !(await save())) return;
    if (step === STEPS.length - 1) {
      if (!draft) return;
      if (!(await save())) return;
      setSaving(true);
      try {
        const result = await listingsApi.submit(draft.id);
        setSubmitted(result);
      } catch (err) {
        setError(errText(err));
      } finally {
        setSaving(false);
      }
      return;
    }
    setStep((s) => s + 1);
  };

  if (submitted)
    return (
      <section className="mx-auto mt-10 max-w-xl rounded-xl border bg-card p-6 text-center sm:p-8">
        <CheckCircle2 className="mx-auto size-9 text-muted-foreground" aria-hidden />
        <h2 className="mt-4 text-xl font-semibold">
          {submitted.status === "PENDING_REVIEW" ? "Submitted for review" : "Listing scheduled"}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {submitted.status === "PENDING_REVIEW"
            ? "An AUCTRA moderator will review your listing before it is published."
            : "Your listing is scheduled and will open for bidding at its start time."}
        </p>
        <button type="button" className={cn(primaryBtn, "mt-6")} onClick={onClose}>
          Back to your listings
        </button>
      </section>
    );

  const cover = photos[0];

  return (
    <section className="mx-auto mt-10 max-w-3xl rounded-xl border bg-card p-5 sm:p-8">
      <div className="mb-8 flex gap-1.5" aria-label="Listing progress">
        {STEPS.map((label, index) => (
          <div
            key={label}
            title={label}
            className={cn("h-1 flex-1 rounded-full", index <= step ? "bg-primary" : "bg-secondary")}
          />
        ))}
      </div>
      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        Step {step + 1} of {STEPS.length}
        {draft && <span className="ml-2 normal-case tracking-normal">· Draft saved</span>}
      </p>
      <h2 className="mb-6 mt-2 text-2xl font-semibold tracking-tight">{STEPS[step]}</h2>

      {step === 0 &&
        (categories === null ? (
          <div className="h-24 animate-pulse rounded-lg bg-muted/50" />
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {categories.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  onClick={() => {
                    set("categorySlug", c.slug);
                    set("subcategorySlug", "");
                  }}
                  className={choiceClass(form.categorySlug === c.slug)}
                >
                  {c.name}
                </button>
              ))}
            </div>
            {category && category.subcategories.length > 0 && (
              <div>
                <p className="mb-2 text-sm text-muted-foreground">Subcategory</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {category.subcategories.map((s) => (
                    <button
                      key={s.slug}
                      type="button"
                      onClick={() => set("subcategorySlug", s.slug)}
                      className={choiceClass(form.subcategorySlug === s.slug)}
                    >
                      {s.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}

      {step === 1 && (
        <div className="space-y-3">
          <Field label="Item title">
            <input
              className={inputClass}
              value={form.title}
              maxLength={200}
              onChange={(e) => set("title", e.target.value)}
              placeholder="e.g. 2019 Porsche 911 Carrera S"
            />
          </Field>
          <Field label="Description">
            <textarea
              className={cn(inputClass, "h-32 py-3")}
              value={form.description}
              maxLength={20000}
              onChange={(e) => set("description", e.target.value)}
              placeholder="History, provenance, notable details (at least 20 characters)"
            />
          </Field>
          {isCar && (
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Make">
                <input
                  className={inputClass}
                  value={form.make}
                  onChange={(e) => set("make", e.target.value)}
                />
              </Field>
              <Field label="Model">
                <input
                  className={inputClass}
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                />
              </Field>
              <Field label="Year">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  maxLength={4}
                  value={form.year}
                  onChange={(e) => set("year", e.target.value.replace(/\D/g, ""))}
                />
              </Field>
              <Field label="Mileage (km)">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  value={form.mileage}
                  onChange={(e) => set("mileage", e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          )}
          {isWatch && (
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Brand">
                <input
                  className={inputClass}
                  value={form.brand}
                  onChange={(e) => set("brand", e.target.value)}
                />
              </Field>
              <Field label="Model">
                <input
                  className={inputClass}
                  value={form.model}
                  onChange={(e) => set("model", e.target.value)}
                />
              </Field>
              <Field label="Year (optional)">
                <input
                  className={inputClass}
                  inputMode="numeric"
                  maxLength={4}
                  value={form.year}
                  onChange={(e) => set("year", e.target.value.replace(/\D/g, ""))}
                />
              </Field>
            </div>
          )}
          {requiredAttrs.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2">
              {requiredAttrs.map((a) => (
                <Field key={a.key} label={a.label + (a.unit ? ` (${a.unit})` : "")}>
                  {a.type === "ENUM" && a.options ? (
                    <select
                      className={inputClass}
                      value={form.attrs[a.key] ?? ""}
                      onChange={(e) => set("attrs", { ...form.attrs, [a.key]: e.target.value })}
                    >
                      <option value="">Select…</option>
                      {a.options.map((o) => (
                        <option key={o} value={o}>
                          {o.replace(/_/g, " ")}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className={inputClass}
                      inputMode={a.type === "NUMBER" ? "decimal" : undefined}
                      value={form.attrs[a.key] ?? ""}
                      onChange={(e) => set("attrs", { ...form.attrs, [a.key]: e.target.value })}
                    />
                  )}
                </Field>
              ))}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CONDITIONS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => set("condition", value)}
                className={choiceClass(form.condition === value)}
              >
                {label}
              </button>
            ))}
          </div>
          <Field label="Condition notes (optional)">
            <textarea
              className={cn(inputClass, "h-24 py-3")}
              value={form.conditionNotes}
              maxLength={2000}
              onChange={(e) => set("conditionNotes", e.target.value)}
            />
          </Field>
        </div>
      )}

      {step === 3 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Starting bid ($)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.start}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, "");
                set("start", v);
                if (!form.increment || form.increment === suggestIncrement(Number(form.start)))
                  set("increment", suggestIncrement(Number(v)));
              }}
            />
          </Field>
          <Field label="Minimum bid increment ($)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.increment}
              onChange={(e) => set("increment", e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="Reserve price (optional, hidden from bidders)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.reserve}
              onChange={(e) => set("reserve", e.target.value.replace(/\D/g, ""))}
            />
          </Field>
          <Field label="Buy-now price (optional)">
            <input
              className={inputClass}
              inputMode="numeric"
              value={form.buyNow}
              onChange={(e) => set("buyNow", e.target.value.replace(/\D/g, ""))}
            />
          </Field>
        </div>
      )}

      {step === 4 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Start">
            <input
              type="datetime-local"
              className={inputClass}
              value={form.startAt}
              onChange={(e) => set("startAt", e.target.value)}
            />
          </Field>
          <Field label="End">
            <input
              type="datetime-local"
              className={inputClass}
              value={form.endAt}
              onChange={(e) => set("endAt", e.target.value)}
            />
          </Field>
        </div>
      )}

      {step === 5 && (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-3">
            {FULFILLMENT.map(([value, label, hint]) => (
              <button
                key={value}
                type="button"
                onClick={() => set("fulfillment", value)}
                className={choiceClass(form.fulfillment === value)}
              >
                <span className="block font-medium">{label}</span>
                <span className="mt-1 block text-xs text-muted-foreground">{hint}</span>
              </button>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Item location (city, optional)">
              <input
                className={inputClass}
                value={form.city}
                maxLength={100}
                onChange={(e) => set("city", e.target.value)}
              />
            </Field>
            <Field label="Shipping notes (optional)">
              <input
                className={inputClass}
                value={form.shippingNotes}
                maxLength={2000}
                onChange={(e) => set("shippingNotes", e.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">
            Continuing saves this listing as a draft in your account so you can add photos.
          </p>
        </div>
      )}

      {step === PHOTOS_STEP && draft && <ListingPhotos auctionId={draft.id} onChange={setPhotos} />}

      {step === 7 && (
        <div className="space-y-5">
          {cover && (
            <AuctionImage
              photo={toPhoto(cover, form.categorySlug)}
              size="card"
              sizes="(min-width: 768px) 700px, 100vw"
              alt={form.title}
              className="aspect-[16/9] w-full rounded-lg object-cover"
            />
          )}
          <dl className="grid gap-px overflow-hidden rounded-lg border bg-border text-sm sm:grid-cols-2">
            {[
              ["Category", [category?.name, sub?.name].filter(Boolean).join(" · ")],
              ["Title", form.title],
              ["Condition", CONDITIONS.find(([v]) => v === form.condition)?.[1] ?? ""],
              ["Photos", `${photos.length}`],
              ["Starting bid", `$${Number(form.start).toLocaleString()}`],
              ["Increment", `$${Number(form.increment).toLocaleString()}`],
              ["Reserve", form.reserve ? `$${Number(form.reserve).toLocaleString()}` : "None"],
              ["Buy now", form.buyNow ? `$${Number(form.buyNow).toLocaleString()}` : "—"],
              [
                "Schedule",
                `${new Date(form.startAt).toLocaleString()} — ${new Date(form.endAt).toLocaleString()}`,
              ],
              ["Delivery", FULFILLMENT.find(([v]) => v === form.fulfillment)?.[1] ?? ""],
            ].map(([label, value]) => (
              <div key={label} className="min-w-0 bg-card p-4">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="mt-1 break-words font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs leading-5 text-muted-foreground">
            Submitting sends the listing to AUCTRA moderators. It is published only after approval.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="mt-6 flex items-center justify-between gap-3 border-t pt-5">
        <button
          type="button"
          disabled={saving}
          onClick={() => {
            setError("");
            if (step === 0 || (step === PHOTOS_STEP && initialStep === PHOTOS_STEP)) onClose();
            else setStep((s) => s - 1);
          }}
          className={ghostBtn}
        >
          {step === 0 ? "Cancel" : "Back"}
        </button>
        <div className="flex gap-2">
          {draft && step < STEPS.length - 1 && (
            <button
              type="button"
              disabled={saving}
              className={ghostBtn}
              onClick={async () => {
                if (await save()) onClose();
              }}
            >
              Save & exit
            </button>
          )}
          <button
            type="button"
            disabled={saving}
            onClick={() => void next()}
            className={primaryBtn}
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {step === STEPS.length - 1 ? "Submit for review" : "Continue"}
          </button>
        </div>
      </div>
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      {label}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}
