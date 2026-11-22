import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { MapPin, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  AccountLayout,
  Empty,
  btn,
  btnGhost,
  input,
  metaFor,
} from "@/components/account/AccountLayout";
import { IS_API_MODE } from "@/lib/auction-store";
import { useSession } from "@/lib/demo-session";
import { COUNTRIES, countryName } from "@/lib/countries";
import {
  ADDRESS_TYPES,
  addressProblems,
  errText,
  useAddressMutations,
  useAddresses,
  type AddressInput,
  type SavedAddress,
} from "@/lib/api/saved";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/addresses")({
  head: () => ({
    meta: metaFor("Address book", "Saved shipping, billing and pickup addresses for checkout."),
  }),
  component: Addresses,
});

const MAX_ADDRESSES = 20;

const blank = (name = ""): AddressInput => ({
  type: "SHIPPING",
  label: "",
  fullName: name,
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "US",
  phone: "",
  isDefault: false,
});

const toInput = (a: SavedAddress): AddressInput => ({
  type: a.type,
  label: a.label ?? "",
  fullName: a.fullName,
  line1: a.line1,
  line2: a.line2 ?? "",
  city: a.city,
  region: a.region ?? "",
  postalCode: a.postalCode ?? "",
  country: a.country,
  phone: a.phone ?? "",
  isDefault: a.isDefault,
});

function Addresses() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const list = useAddresses();
  // null = closed, "new" = adding, otherwise the id being edited.
  const [editing, setEditing] = useState<string | null>(null);

  if (!IS_API_MODE)
    return (
      <AccountLayout title="Address book">
        <Empty
          title="The address book needs the AUCTRA server"
          body="Addresses are stored securely on the server, so they are not available in the offline demo."
        />
      </AccountLayout>
    );
  if (!restored)
    return (
      <AccountLayout title="Address book">
        <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
      </AccountLayout>
    );
  if (!user)
    return (
      <AccountLayout title="Address book">
        <Empty
          title="Sign in to manage your addresses"
          body="Save delivery addresses once and pick them at checkout."
          action={
            <Link to="/login" className={btn}>
              Sign in
            </Link>
          }
        />
      </AccountLayout>
    );

  const items = list.data ?? [];
  const full = items.length >= MAX_ADDRESSES;
  const adding = editing === "new";

  return (
    <AccountLayout
      title="Address book"
      description={
        list.isSuccess
          ? `${items.length} saved address${items.length === 1 ? "" : "es"} · used to pre-fill checkout`
          : "Saved addresses used to pre-fill checkout"
      }
      actions={
        !adding && (
          <button
            className={btn}
            disabled={!list.isSuccess || full}
            title={full ? `You can save up to ${MAX_ADDRESSES} addresses.` : undefined}
            onClick={() => setEditing("new")}
          >
            <Plus className="size-4" /> Add address
          </button>
        )
      }
    >
      {adding && (
        <AddressForm
          initial={blank(user.name)}
          first={items.length === 0}
          onDone={() => setEditing(null)}
        />
      )}
      {list.isPending ? (
        <div className="h-48 animate-pulse rounded-lg bg-muted/40" />
      ) : list.isError ? (
        <p role="alert" className="rounded-lg border p-6 text-sm text-live">
          {errText(list.error, "Couldn't load your addresses.")}
        </p>
      ) : items.length === 0 ? (
        !adding && (
          <Empty
            title="No saved addresses yet"
            body="Add a shipping address and it will be offered at checkout."
            action={
              <button className={btn} onClick={() => setEditing("new")}>
                <Plus className="size-4" /> Add address
              </button>
            }
          />
        )
      ) : (
        <ul
          aria-label="Saved addresses"
          className={cn("grid gap-4 md:grid-cols-2", adding && "mt-6")}
        >
          {items.map((a) =>
            editing === a.id ? (
              <li key={a.id} className="md:col-span-2">
                <AddressForm id={a.id} initial={toInput(a)} onDone={() => setEditing(null)} />
              </li>
            ) : (
              <AddressCard key={a.id} address={a} onEdit={() => setEditing(a.id)} />
            ),
          )}
        </ul>
      )}
    </AccountLayout>
  );
}

function AddressCard({ address: a, onEdit }: { address: SavedAddress; onEdit: () => void }) {
  const { remove, makeDefault } = useAddressMutations();
  const [confirming, setConfirming] = useState(false);
  const typeLabel = ADDRESS_TYPES.find((t) => t.value === a.type)?.label ?? a.type;
  return (
    <li className="flex flex-col rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <MapPin className="size-4 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{a.label || typeLabel}</p>
        <span className="rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground">
          {typeLabel}
        </span>
        {a.isDefault && (
          <span className="rounded-full bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground">
            Default
          </span>
        )}
      </div>
      <address className="mt-3 text-sm not-italic leading-relaxed text-muted-foreground">
        <span className="text-foreground">{a.fullName}</span>
        <br />
        {a.line1}
        {a.line2 && (
          <>
            <br />
            {a.line2}
          </>
        )}
        <br />
        {[a.city, a.region, a.postalCode].filter(Boolean).join(", ")}
        <br />
        {countryName(a.country)}
        {a.phone && (
          <>
            <br />
            {a.phone}
          </>
        )}
      </address>
      <div className="mt-4 flex flex-wrap gap-2 border-t pt-3">
        {confirming ? (
          <>
            <span className="mr-auto self-center text-sm">Delete this address?</span>
            <button className={btnGhost} onClick={() => setConfirming(false)}>
              Keep
            </button>
            <button
              className={cn(btn, "bg-live text-live-foreground")}
              disabled={remove.isPending}
              onClick={() =>
                remove.mutate(a.id, {
                  onSuccess: () => toast.success("Address deleted"),
                  onError: (err) => {
                    setConfirming(false);
                    toast.error(errText(err, "Couldn't delete the address."));
                  },
                })
              }
            >
              Delete
            </button>
          </>
        ) : (
          <>
            <button
              className={btnGhost}
              onClick={onEdit}
              aria-label={`Edit ${a.label || typeLabel} address`}
            >
              <Pencil className="size-3.5" /> Edit
            </button>
            {!a.isDefault && (
              <button
                className={btnGhost}
                disabled={makeDefault.isPending}
                onClick={() =>
                  makeDefault.mutate(a.id, {
                    onSuccess: () =>
                      toast.success(`Default ${typeLabel.toLowerCase()} address updated`),
                    onError: (err) => toast.error(errText(err, "Couldn't update the address.")),
                  })
                }
              >
                <Star className="size-3.5" /> Make default
              </button>
            )}
            <button
              className={cn(btnGhost, "ml-auto text-live")}
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${a.label || typeLabel} address`}
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
    </li>
  );
}

function AddressForm({
  id,
  initial,
  first = false,
  onDone,
}: {
  id?: string;
  initial: AddressInput;
  first?: boolean;
  onDone: () => void;
}) {
  const { create, update } = useAddressMutations();
  const [a, setA] = useState<AddressInput>(first ? { ...initial, isDefault: true } : initial);
  const [shown, setShown] = useState<ReturnType<typeof addressProblems>>({});
  const busy = create.isPending || update.isPending;
  const set = (patch: Partial<AddressInput>) => setA((cur) => ({ ...cur, ...patch }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const problems = addressProblems(a);
    setShown(problems);
    if (Object.keys(problems).length) return;
    const opts = {
      onSuccess: () => {
        toast.success(id ? "Address updated" : "Address saved");
        onDone();
      },
      onError: (err: unknown) => toast.error(errText(err, "Couldn't save the address.")),
    };
    if (id) update.mutate({ id, body: a }, opts);
    else create.mutate(a, opts);
  };

  const field = (
    key: "label" | "fullName" | "line1" | "line2" | "city" | "region" | "postalCode" | "phone",
    label: string,
    opts: { autoComplete?: string; wide?: boolean; required?: boolean; max: number },
  ) => (
    <label className={cn("block text-sm", opts.wide && "sm:col-span-2")}>
      {label}
      {!opts.required && <span className="text-muted-foreground"> (optional)</span>}
      <input
        name={key}
        value={a[key] ?? ""}
        maxLength={opts.max}
        autoComplete={opts.autoComplete}
        aria-invalid={Boolean(shown[key])}
        onChange={(e) => set({ [key]: e.target.value })}
        className={cn(input, "mt-1.5", shown[key] && "border-live")}
      />
      {shown[key] && <span className="mt-1 block text-xs text-live">{shown[key]}</span>}
    </label>
  );

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={id ? "Edit address" : "New address"}
      className="rounded-lg border bg-card p-5"
    >
      <p className="mb-4 text-sm font-medium">{id ? "Edit address" : "New address"}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          Type
          <select
            name="type"
            value={a.type}
            onChange={(e) => set({ type: e.target.value as AddressInput["type"] })}
            className={cn(input, "mt-1.5")}
          >
            {ADDRESS_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {field("label", "Label", { max: 60 })}
        {field("fullName", "Full name", {
          autoComplete: "name",
          wide: true,
          required: true,
          max: 120,
        })}
        {field("line1", "Street address", {
          autoComplete: "address-line1",
          wide: true,
          required: true,
          max: 200,
        })}
        {field("line2", "Apartment, suite", {
          autoComplete: "address-line2",
          wide: true,
          max: 200,
        })}
        {field("city", "City", { autoComplete: "address-level2", required: true, max: 100 })}
        {field("region", "State / region", { autoComplete: "address-level1", max: 100 })}
        {field("postalCode", "Postal code", { autoComplete: "postal-code", max: 20 })}
        <label className="block text-sm">
          Country
          <select
            name="country"
            value={a.country}
            autoComplete="country"
            onChange={(e) => set({ country: e.target.value })}
            className={cn(input, "mt-1.5")}
          >
            {!COUNTRIES.some(([c]) => c === a.country) && (
              <option value={a.country}>{a.country}</option>
            )}
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </select>
        </label>
        {field("phone", "Phone", { autoComplete: "tel", wide: true, max: 32 })}
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            name="isDefault"
            checked={Boolean(a.isDefault)}
            onChange={(e) => set({ isDefault: e.target.checked })}
            className="size-4 accent-primary"
          />
          Use as my default {ADDRESS_TYPES.find((t) => t.value === a.type)?.label.toLowerCase()}{" "}
          address
        </label>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className={btnGhost} onClick={onDone} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className={btn} disabled={busy}>
          {busy ? "Saving…" : id ? "Save changes" : "Save address"}
        </button>
      </div>
    </form>
  );
}
