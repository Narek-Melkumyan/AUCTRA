import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, Plus, ShieldCheck, Upload } from "lucide-react";
import { toast } from "sonner";

import { SellerWorkspace } from "@/components/sell/SellerWorkspace";
import { IS_API_MODE } from "@/lib/auction-store";
import { categories } from "@/lib/auctions";
import { useSession } from "@/lib/demo-session";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/sell")({
  head: () => ({
    meta: [
      { title: "Sell an Item — AUCTRA" },
      {
        name: "description",
        content: "Create an auction listing for cars, watches, art, jewelry and more.",
      },
      {
        property: "og:title",
        content: "Sell an Item — AUCTRA",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Sell,
});

// SELLER PAGE

function Sell() {
  const user = useSession((state) => state.user);
  const [wizardOpen, setWizardOpen] = useState(false);

  if (!user) {
    return <GuestSellerPage />;
  }

  // With the backend connected, listings and photos are saved for real.
  if (IS_API_MODE) {
    return <SellerWorkspace user={user} />;
  }

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
            Create and manage your auction listings.
          </p>
        </div>

        {!wizardOpen && (
          <button
            type="button"
            onClick={() => setWizardOpen(true)}
            className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="size-4" />
            Create listing
          </button>
        )}
      </div>

      {wizardOpen ? (
        <Wizard onClose={() => setWizardOpen(false)} />
      ) : (
        <div className="mt-8 grid gap-5 lg:grid-cols-[1fr_300px]">
          <section className="rounded-xl border bg-card p-7 sm:p-10">
            <div className="grid size-12 place-items-center rounded-lg bg-secondary">
              <Plus className="size-6 text-muted-foreground" />
            </div>

            <h2 className="mt-6 text-xl font-semibold">Your listings</h2>

            <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">
              You have no published listings yet. Create a listing preview to see how the submission
              process works.
            </p>

            <button
              type="button"
              onClick={() => setWizardOpen(true)}
              className="mt-6 inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-accent"
            >
              Create your first listing
              <ArrowRight className="size-4" />
            </button>
          </section>

          <aside className="rounded-xl border bg-card p-6">
            <h2 className="text-base font-semibold">Before you list</h2>

            <div className="mt-5 space-y-4 text-sm text-muted-foreground">
              {[
                "Prepare clear item photos.",
                "Describe the condition accurately.",
                "Choose pricing and auction times.",
              ].map((item) => (
                <p key={item} className="flex gap-3">
                  <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
                  {item}
                </p>
              ))}
            </div>

            <p className="mt-6 border-t pt-4 text-xs leading-5 text-muted-foreground">
              Preview only: listings are not stored or published until the backend is connected.
            </p>
          </aside>
        </div>
      )}
    </main>
  );
}

// GUEST SELLER PAGE

function GuestSellerPage() {
  const steps = [
    {
      number: "01",
      title: "Create an account",
      body: "Register or sign in to start selling.",
    },
    {
      number: "02",
      title: "Describe your item",
      body: "Add photos, details and condition.",
    },
    {
      number: "03",
      title: "Set auction terms",
      body: "Choose a starting bid and schedule.",
    },
  ];

  return (
    <main className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-20">
      <div className="grid gap-12 lg:grid-cols-[1.2fr_0.8fr] lg:items-center lg:gap-20">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            SELL ON AUCTRA
          </p>

          <h1 className="mt-6 max-w-2xl text-4xl font-medium tracking-tight sm:text-5xl lg:text-6xl lg:leading-[1.1]">
            Exceptional items deserve the right audience.
          </h1>

          <p className="mt-6 max-w-xl text-base leading-7 text-muted-foreground">
            From cars and collectible watches to art and jewelry, create an auction listing with a
            straightforward, professional selling experience.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/login"
              search={{
                mode: "up",
                redirect: "/sell",
              }}
              className="inline-flex h-11 items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              Create an account
              <ArrowRight className="size-4" />
            </Link>

            <Link
              to="/login"
              search={{
                mode: "in",
                redirect: "/sell",
              }}
              className="inline-flex h-11 items-center rounded-md border px-5 text-sm font-medium hover:bg-accent"
            >
              Sign in
            </Link>
          </div>

          <p className="mt-4 text-xs text-muted-foreground">
            On the next page, choose Register to create a demo account.
          </p>
        </div>

        <aside className="rounded-xl border bg-card p-6 sm:p-8">
          <div className="flex items-center gap-3 border-b pb-5">
            <ShieldCheck className="size-5" />

            <div>
              <p className="text-sm font-semibold">A simple selling process</p>

              <p className="text-xs text-muted-foreground">Everything in one workspace</p>
            </div>
          </div>

          <div className="mt-6 space-y-7">
            {steps.map((step) => (
              <div key={step.number} className="flex gap-4">
                <span className="font-mono text-sm text-muted-foreground">{step.number}</span>

                <div>
                  <h2 className="text-sm font-semibold">{step.title}</h2>

                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{step.body}</p>
                </div>
              </div>
            ))}
          </div>

          <p className="mt-8 border-t pt-5 text-xs leading-5 text-muted-foreground">
            {IS_API_MODE
              ? "Listings are reviewed by AUCTRA before they go live. Checkout is simulated — no real payments are taken."
              : "AUCTRA is currently a preview. No real listings or transactions are created."}
          </p>
        </aside>
      </div>
    </main>
  );
}

// LISTING WIZARD

const steps = [
  "Category",
  "Item info",
  "Photos",
  "Condition",
  "Pricing",
  "Schedule",
  "Shipping",
  "Preview",
] as const;

function Wizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const [photos, setPhotos] = useState<File[]>([]);
  const [error, setError] = useState("");

  const [data, setData] = useState({
    category: "",
    title: "",
    description: "",
    condition: "",
    start: "",
    reserve: "",
    startAt: "",
    endAt: "",
    shipping: "",
  });

  const inputClass =
    "h-11 w-full rounded-md border bg-background px-3 text-sm outline-none focus:border-ring";

  const choiceClass = (active: boolean) =>
    cn(
      "rounded-md border px-4 py-3 text-left text-sm transition hover:bg-accent",
      active && "border-foreground bg-accent",
    );

  const validate = (): string => {
    if (step === 0 && !data.category) {
      return "Choose a category.";
    }

    if (step === 1 && data.title.trim().length < 5) {
      return "Title must be at least 5 characters.";
    }

    if (step === 2 && photos.length === 0) {
      return "Choose at least one photo.";
    }

    if (step === 3 && !data.condition) {
      return "Select a condition.";
    }

    if (step === 4 && !(Number(data.start) > 0)) {
      return "Enter a starting bid.";
    }

    if (step === 4 && data.reserve && Number(data.reserve) < Number(data.start)) {
      return "Reserve cannot be below the starting bid.";
    }

    if (step === 5 && (!data.startAt || !data.endAt)) {
      return "Choose both auction times.";
    }

    if (step === 5 && new Date(data.endAt).getTime() <= new Date(data.startAt).getTime()) {
      return "End time must be after start time.";
    }

    if (step === 6 && !data.shipping) {
      return "Choose a shipping option.";
    }

    return "";
  };

  const next = () => {
    const message = validate();
    setError(message);

    if (message) return;

    if (step === steps.length - 1) {
      toast.info("Listing preview complete. Nothing has been published.");
      onClose();
      return;
    }

    setStep((current) => current + 1);
  };

  return (
    <section className="mx-auto mt-10 max-w-3xl rounded-xl border bg-card p-5 sm:p-8">
      <div className="mb-8 flex gap-1.5" aria-label="Listing progress">
        {steps.map((label, index) => (
          <div
            key={label}
            title={label}
            className={cn("h-1 flex-1 rounded-full", index <= step ? "bg-primary" : "bg-secondary")}
          />
        ))}
      </div>

      <p className="text-xs uppercase tracking-widest text-muted-foreground">
        Step {step + 1} of {steps.length}
      </p>

      <h2 className="mb-6 mt-2 text-2xl font-semibold tracking-tight">{steps[step]}</h2>

      {/* STEP 1 - CATEGORY */}

      {step === 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {categories.map((item) => (
            <button
              key={item.name}
              type="button"
              onClick={() =>
                setData((prev) => ({
                  ...prev,
                  category: item.name,
                }))
              }
              className={choiceClass(data.category === item.name)}
            >
              {item.name}
            </button>
          ))}
        </div>
      )}

      {/* STEP 2 - ITEM INFO */}

      {step === 1 && (
        <div className="space-y-3">
          <label className="block text-sm">
            Item title
            <input
              className={cn(inputClass, "mt-1.5")}
              value={data.title}
              onChange={(event) =>
                setData((prev) => ({
                  ...prev,
                  title: event.target.value,
                }))
              }
              placeholder="e.g. 2023 Porsche 911 Carrera"
            />
          </label>

          <label className="block text-sm">
            Description
            <textarea
              className={cn(inputClass, "mt-1.5 h-32 py-3")}
              value={data.description}
              onChange={(event) =>
                setData((prev) => ({
                  ...prev,
                  description: event.target.value,
                }))
              }
              placeholder="Describe your item"
            />
          </label>
        </div>
      )}

      {/* STEP 3 - PHOTOS */}

      {step === 2 && (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <Upload className="mx-auto size-7 text-muted-foreground" />

          <label className="mt-4 block cursor-pointer text-sm font-medium">
            Choose photos
            <input
              type="file"
              accept="image/*"
              multiple
              className="mt-3 block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-2 file:text-foreground"
              onChange={(event) => setPhotos(Array.from(event.target.files ?? []))}
            />
          </label>

          <p className="mt-3 text-xs text-muted-foreground">
            {photos.length} selected. Files stay in this browser and are not uploaded.
          </p>

          {photos.length > 0 && (
            <ul className="mt-3 space-y-1 text-left text-xs text-muted-foreground">
              {photos.map((file, index) => (
                <li key={`${file.name}-${index}`} className="truncate">
                  {file.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* STEP 4 - CONDITION */}

      {step === 3 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {["New", "Excellent", "Very Good", "Good", "Fair"].map((condition) => (
            <button
              key={condition}
              type="button"
              onClick={() =>
                setData((prev) => ({
                  ...prev,
                  condition,
                }))
              }
              className={choiceClass(data.condition === condition)}
            >
              {condition}
            </button>
          ))}
        </div>
      )}

      {/* STEP 5 - PRICING */}

      {step === 4 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            Starting bid ($)
            <input
              className={cn(inputClass, "mt-1.5")}
              inputMode="numeric"
              value={data.start}
              onChange={(event) =>
                setData((prev) => ({
                  ...prev,
                  start: event.target.value.replace(/\D/g, ""),
                }))
              }
            />
          </label>

          <label className="block text-sm">
            Reserve price (optional)
            <input
              className={cn(inputClass, "mt-1.5")}
              inputMode="numeric"
              value={data.reserve}
              onChange={(event) =>
                setData((prev) => ({
                  ...prev,
                  reserve: event.target.value.replace(/\D/g, ""),
                }))
              }
            />
          </label>
        </div>
      )}

      {/* STEP 6 - SCHEDULE */}

      {step === 5 && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            Start
            <input
              type="datetime-local"
              className={cn(inputClass, "mt-1.5")}
              value={data.startAt}
              onChange={(event) =>
                setData((prev) => ({
                  ...prev,
                  startAt: event.target.value,
                }))
              }
            />
          </label>

          <label className="block text-sm">
            End
            <input
              type="datetime-local"
              className={cn(inputClass, "mt-1.5")}
              value={data.endAt}
              onChange={(event) =>
                setData((prev) => ({
                  ...prev,
                  endAt: event.target.value,
                }))
              }
            />
          </label>
        </div>
      )}

      {/* STEP 7 - SHIPPING */}

      {step === 6 && (
        <div className="grid gap-2 sm:grid-cols-3">
          {["Buyer pickup", "Seller ships", "White-glove"].map((shipping) => (
            <button
              key={shipping}
              type="button"
              onClick={() =>
                setData((prev) => ({
                  ...prev,
                  shipping,
                }))
              }
              className={choiceClass(data.shipping === shipping)}
            >
              {shipping}
            </button>
          ))}
        </div>
      )}

      {/* STEP 8 - PREVIEW */}

      {step === 7 && (
        <dl className="grid gap-px overflow-hidden rounded-lg border bg-border text-sm sm:grid-cols-2">
          {[
            ["Category", data.category],
            ["Title", data.title],
            ["Description", data.description || "Not provided"],
            ["Photos", `${photos.length} selected`],
            ["Condition", data.condition],
            ["Starting bid", `$${Number(data.start).toLocaleString()}`],
            ["Reserve", data.reserve ? `$${Number(data.reserve).toLocaleString()}` : "None"],
            ["Schedule", `${data.startAt} — ${data.endAt}`],
            ["Shipping", data.shipping],
          ].map(([label, value]) => (
            <div key={label} className="min-w-0 bg-card p-4">
              <dt className="text-muted-foreground">{label}</dt>

              <dd className="mt-1 break-words font-medium">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {error}
        </p>
      )}

      <p className="mt-6 text-xs leading-5 text-muted-foreground">
        Preview only. Your listing will not be submitted to an auction server.
      </p>

      <div className="mt-5 flex items-center justify-between gap-3 border-t pt-5">
        <button
          type="button"
          onClick={() => {
            if (step === 0) {
              onClose();
            } else {
              setError("");
              setStep((current) => current - 1);
            }
          }}
          className="h-10 rounded-md border px-5 text-sm font-medium hover:bg-accent"
        >
          {step === 0 ? "Cancel" : "Back"}
        </button>

        <button
          type="button"
          onClick={next}
          className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {step === steps.length - 1 ? "Finish preview" : "Continue"}
        </button>
      </div>
    </section>
  );
}
