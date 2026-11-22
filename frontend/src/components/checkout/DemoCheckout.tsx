import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BadgeCheck, CheckCircle2, Info, Lock } from "lucide-react";
import { toast } from "sonner";
import { Empty, btn, btnGhost, input } from "@/components/account/AccountLayout";
import { getRoomsSnapshot } from "@/lib/auction-store";
import { useSession, setApiSession } from "@/lib/demo-session";
import { mediaUrl, toOrder } from "@/lib/api/adapters";
import { ApiError, api } from "@/lib/api/client";
import { checkoutApi, type Address, type DeliveryKey, type Money } from "@/lib/api/checkout";
import type { OrderDto } from "@/lib/api/types";
import { cn } from "@/lib/utils";
import { photoOf } from "@/lib/media";
import { COUNTRIES } from "@/lib/countries";
import { useAddresses, type SavedAddress } from "@/lib/api/saved";

const fmt = (m: Money | { minor: bigint; currency: string }) => {
  const digits = m.currency === "JPY" ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  }).format(Number(m.minor) / 10 ** digits);
};

const fromSaved = (a: SavedAddress): Address => ({
  fullName: a.fullName,
  line1: a.line1,
  line2: a.line2 ?? "",
  city: a.city,
  postalCode: a.postalCode ?? "",
  country: a.country,
});

/**
 * Simulated checkout for the winning bidder (API mode). No card, bank or payment
 * credentials are requested; the server records a demo order flagged as simulated.
 */
export function DemoCheckout() {
  const { id } = useParams({ from: "/checkout/$id" });
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["checkout", id, user?.id],
    queryFn: () => checkoutApi.summary(id),
    enabled: !!user,
    retry: false,
  });
  const [delivery, setDelivery] = useState<DeliveryKey | null>(null);
  const [address, setAddress] = useState<Address>({
    fullName: user?.name ?? "",
    line1: "",
    line2: "",
    city: "",
    postalCode: "",
    country: "US",
  });
  // Saved shipping addresses from the address book: the default one pre-fills the form.
  const saved = useAddresses();
  const shipping = useMemo(
    () => (saved.data ?? []).filter((a) => a.type === "SHIPPING"),
    [saved.data],
  );
  const [savedId, setSavedId] = useState("");
  const applySaved = (a: SavedAddress) => {
    setSavedId(a.id);
    setAddress(fromSaved(a));
  };
  const prefilled = useRef(false);
  useEffect(() => {
    const d = shipping.find((a) => a.isDefault) ?? shipping[0];
    if (prefilled.current || !d) return;
    prefilled.current = true;
    setSavedId(d.id);
    setAddress(fromSaved(d));
  }, [shipping]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ orderNumber: string; total: Money } | null>(null);
  // One idempotency key per checkout attempt: retries of the same click are recognised.
  const key = useRef(`demo-${crypto.randomUUID()}`);

  const option = useMemo(() => {
    const opts = q.data?.deliveryOptions ?? [];
    return opts.find((o) => o.key === delivery) ?? opts[0] ?? null;
  }, [q.data, delivery]);

  if (!restored || (user && q.isPending))
    return (
      <div className="mx-auto mt-16 h-96 max-w-[1080px] animate-pulse rounded-2xl bg-muted/40" />
    );
  if (!user)
    return (
      <Shell>
        <Empty
          title="Sign in to check out"
          body="Only the winning bidder can complete the demo checkout."
          action={
            <Link to="/login" className={btn}>
              Sign in
            </Link>
          }
        />
      </Shell>
    );
  if (q.isError) {
    const e = q.error;
    const code = e instanceof ApiError ? e.code : "";
    return (
      <Shell>
        <Empty
          title={
            code === "NOT_THE_WINNER"
              ? "This lot was won by another bidder"
              : code === "CHECKOUT_NOT_AVAILABLE"
                ? "Checkout isn't available for this lot"
                : "We couldn't load checkout"
          }
          body={e instanceof ApiError ? e.message : "Please try again."}
          action={
            <Link to="/bids" className={btn}>
              Go to my bids
            </Link>
          }
        />
      </Shell>
    );
  }
  const s = q.data!;
  if (done || s.completed)
    return (
      <Shell>
        <div className="mx-auto max-w-lg py-10 text-center">
          <CheckCircle2 className="mx-auto size-10 text-success" aria-hidden />
          <p className="mt-4 text-xs font-semibold uppercase tracking-[0.14em] text-primary">
            Demo Order Completed
          </p>
          <h1 className="mt-2 font-display text-3xl">{s.auction.title}</h1>
          <p className="mt-3 text-sm text-muted-foreground">
            Order{" "}
            <span className="font-medium text-foreground">
              {done?.orderNumber ?? s.orderNumber}
            </span>{" "}
            · {fmt(done?.total ?? s.total)}
          </p>
          <p className="mx-auto mt-4 max-w-sm rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            Simulated transaction — no real payment was made and no card details were collected.
          </p>
          <div className="mt-8 flex justify-center gap-2">
            <Link to="/orders" className={btn}>
              View order history
            </Link>
            <Link to="/live" className={btnGhost}>
              Keep browsing
            </Link>
          </div>
        </div>
      </Shell>
    );

  const shippingMinor = BigInt(option?.price.minor ?? "0");
  const total = {
    minor:
      BigInt(s.hammerPrice.minor) +
      BigInt(s.buyerPremium.minor) +
      BigInt(s.tax.minor) +
      shippingMinor,
    currency: s.total.currency,
  };
  const room = getRoomsSnapshot()[s.auction.id];
  const image =
    (room ? photoOf(room)?.card : undefined) ??
    (s.auction.image ? mediaUrl(s.auction.image, s.auction.categorySlug) : null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!option || busy) return;
    if (option.needsAddress) {
      const a = address;
      if (
        a.fullName.trim().length < 2 ||
        a.line1.trim().length < 3 ||
        a.city.trim().length < 2 ||
        a.postalCode.trim().length < 2
      ) {
        toast.error("Complete the delivery address.");
        return;
      }
    }
    setBusy(true);
    try {
      const r = await checkoutApi.complete(
        s.orderId,
        {
          delivery: option.key,
          ...(option.needsAddress
            ? {
                address: {
                  ...address,
                  ...(address.line2?.trim() ? {} : { line2: undefined }),
                } as Address,
              }
            : {}),
        },
        key.current,
      );
      setDone({ orderNumber: r.order.orderNumber, total: r.order.total });
      toast.success("Demo order completed — no real payment was made");
      const orders = await api<OrderDto[]>("/me/orders").catch(() => null);
      if (orders) setApiSession({ orders: orders.filter((o) => o.role === "buyer").map(toOrder) });
      void qc.invalidateQueries({ queryKey: ["checkout", id] });
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "Couldn't complete the demo checkout. Try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1080px] px-4 py-10 sm:px-6">
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p>
          <span className="font-medium">Demo Checkout · No Real Payment Required.</span>{" "}
          <span className="text-muted-foreground">
            AUCTRA is a portfolio demo marketplace. Completing checkout records a simulated
            transaction — nothing is charged and no card details are collected.
          </span>
        </p>
      </div>
      <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
        <form onSubmit={(e) => void submit(e)} className="space-y-8">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">Demo checkout</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Lot {s.auction.lotNumber} · {s.auction.title} · order {s.orderNumber}
            </p>
          </div>

          <fieldset>
            <legend className="mb-3 text-sm font-medium">Delivery</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {s.deliveryOptions.map((o) => (
                <button
                  type="button"
                  key={o.key}
                  aria-pressed={option?.key === o.key}
                  onClick={() => setDelivery(o.key)}
                  className={cn(
                    "rounded-md border p-3 text-left text-sm",
                    option?.key === o.key && "border-foreground",
                  )}
                >
                  {o.label}
                  <span className="block text-xs text-muted-foreground tabular">
                    {o.price.minor === "0" ? "Free" : fmt(o.price)}
                  </span>
                </button>
              ))}
            </div>
            {s.auction.shippingNotes && (
              <p className="mt-3 text-xs text-muted-foreground">{s.auction.shippingNotes}</p>
            )}
            {option?.needsAddress && (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {shipping.length > 0 && (
                  <label className="block text-sm sm:col-span-2">
                    Saved address
                    <select
                      value={savedId}
                      onChange={(e) => {
                        const a = shipping.find((x) => x.id === e.target.value);
                        if (a) applySaved(a);
                        else setSavedId("");
                      }}
                      className={cn(input, "mt-1.5")}
                    >
                      {shipping.map((a) => (
                        <option key={a.id} value={a.id}>
                          {[a.label, a.line1, a.city].filter(Boolean).join(" · ")}
                          {a.isDefault ? " (default)" : ""}
                        </option>
                      ))}
                      <option value="">Enter a different address</option>
                    </select>
                    <Link
                      to="/addresses"
                      className="mt-1 inline-block text-xs text-muted-foreground underline-offset-4 hover:underline"
                    >
                      Manage address book
                    </Link>
                  </label>
                )}
                <label className="block text-sm sm:col-span-2">
                  Full name
                  <input
                    required
                    autoComplete="name"
                    value={address.fullName}
                    onChange={(e) => setAddress({ ...address, fullName: e.target.value })}
                    className={cn(input, "mt-1.5")}
                  />
                </label>
                <label className="block text-sm sm:col-span-2">
                  Address
                  <input
                    required
                    autoComplete="address-line1"
                    value={address.line1}
                    onChange={(e) => setAddress({ ...address, line1: e.target.value })}
                    className={cn(input, "mt-1.5")}
                  />
                </label>
                <label className="block text-sm sm:col-span-2">
                  Apartment, suite (optional)
                  <input
                    autoComplete="address-line2"
                    value={address.line2}
                    onChange={(e) => setAddress({ ...address, line2: e.target.value })}
                    className={cn(input, "mt-1.5")}
                  />
                </label>
                <label className="block text-sm">
                  City
                  <input
                    required
                    autoComplete="address-level2"
                    value={address.city}
                    onChange={(e) => setAddress({ ...address, city: e.target.value })}
                    className={cn(input, "mt-1.5")}
                  />
                </label>
                <label className="block text-sm">
                  Postal code
                  <input
                    required
                    autoComplete="postal-code"
                    value={address.postalCode}
                    onChange={(e) => setAddress({ ...address, postalCode: e.target.value })}
                    className={cn(input, "mt-1.5")}
                  />
                </label>
                <label className="block text-sm sm:col-span-2">
                  Country
                  <select
                    value={address.country}
                    onChange={(e) => setAddress({ ...address, country: e.target.value })}
                    className={cn(input, "mt-1.5")}
                  >
                    {COUNTRIES.map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </fieldset>

          <fieldset>
            <legend className="mb-3 text-sm font-medium">Payment</legend>
            <div className="flex items-start gap-3 rounded-md border p-4 text-sm">
              <BadgeCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
              <div>
                <p className="font-medium">Simulated Transaction</p>
                <p className="mt-0.5 text-muted-foreground">
                  No real payment required. There are no card or bank fields — confirming records a
                  demo payment marked as simulated.
                </p>
              </div>
            </div>
          </fieldset>

          <button className={cn(btn, "h-11 w-full sm:w-auto")} disabled={busy || !option}>
            <Lock className="size-4" aria-hidden />
            {busy ? "Completing…" : `Complete demo purchase · ${fmt(total)}`}
          </button>
        </form>

        <aside className="h-fit rounded-lg border bg-card p-5 lg:sticky lg:top-24">
          {image && (
            <img src={image} alt="" className="aspect-[4/3] w-full rounded-md object-cover" />
          )}
          <p className="mt-3 text-sm font-medium">{s.auction.title}</p>
          <dl className="mt-4 space-y-2 text-sm">
            {[
              ["Winning bid (hammer price)", fmt(s.hammerPrice)],
              ["Buyer's premium", fmt(s.buyerPremium)],
              [
                "Delivery",
                option
                  ? shippingMinor === 0n
                    ? "Free"
                    : fmt({ minor: shippingMinor, currency: s.total.currency })
                  : "—",
              ],
              ...(s.tax.minor !== "0" ? [["Tax", fmt(s.tax)]] : []),
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="tabular">{v}</dd>
              </div>
            ))}
            <div className="flex justify-between border-t pt-3 font-medium">
              <dt>Total (simulated)</dt>
              <dd className="tabular">{fmt(total)}</dd>
            </div>
          </dl>
          <p className="mt-4 text-xs text-muted-foreground">
            Fees come from AUCTRA's platform configuration. Nothing is charged.
          </p>
        </aside>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-xl px-4 py-16">{children}</div>;
}
