import { useEffect, useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";

import { btn, input, metaFor } from "@/components/account/AccountLayout";
import { Logo } from "@/components/layout/AppShell";
import { API_MODE, services } from "@/services";
import { cn } from "@/lib/utils";

type AuthMode = "in" | "up";

type LoginSearch = {
  mode?: AuthMode;
  redirect?: "/sell";
};

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    mode: search["mode"] === "up" ? "up" : "in",
    ...(search["redirect"] === "/sell" ? { redirect: "/sell" as const } : {}),
  }),

  head: () => ({
    meta: metaFor("Sign in", "Sign in or create an AUCTRA account to bid, watch and sell."),
  }),

  component: Login,
});

function Login() {
  const navigate = useNavigate();

  const { mode: requestedMode, redirect } = Route.useSearch();

  const [mode, setMode] = useState<AuthMode>(requestedMode ?? "in");

  const [error, setError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setMode(requestedMode ?? "in");
    setError(null);
  }, [requestedMode]);

  const changeMode = (newMode: AuthMode) => {
    if (loading) return;

    setMode(newMode);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (loading) return;

    const form = new FormData(event.currentTarget);

    const email = String(form.get("email") ?? "").trim();

    const password = String(form.get("password") ?? "");

    const name = String(form.get("name") ?? "").trim();

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter a valid email address.");
      return;
    }

    if (password.length < 10) {
      setError("Password must be at least 10 characters.");
      return;
    }

    if (mode === "up" && !name) {
      setError("Enter your full name.");
      return;
    }

    if (mode === "up" && !form.get("terms")) {
      setError("Please accept the terms to continue.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      const result =
        mode === "up"
          ? await services.auth.register(name, email, password)
          : await services.auth.signIn(email, password);

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (mode === "up" && API_MODE === "api") {
        toast.success("Account created. Verify your email to start bidding.");
        const { registrationDelivery } = await import("@/services/api");
        await navigate({
          to: "/verify-email",
          search: { token: "", delivery: registrationDelivery() },
          replace: true,
        });
        return;
      }

      toast.success(mode === "up" ? "Demo account created successfully" : "Signed in successfully");

      await navigate({
        to: redirect === "/sell" ? "/sell" : "/dashboard",
        replace: true,
      });
    } catch (err) {
      console.error("Authentication error:", err);

      setError("Unable to sign in right now. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="mx-auto grid min-h-[calc(100vh-8rem)] max-w-sm content-center px-4 py-12">
      {/* Logo */}

      <div className="mb-8">
        <Logo />
      </div>

      {/* Heading */}

      <h1 className="text-2xl font-medium tracking-tight">
        {mode === "in" ? "Sign in" : "Create your account"}
      </h1>

      <p className="mt-1 text-sm text-muted-foreground">
        {redirect === "/sell"
          ? "Sign in or register to start selling on AUCTRA."
          : mode === "in"
            ? "Welcome back."
            : "Bid, watch and sell on AUCTRA."}
      </p>

      {/* Auth mode tabs */}

      <div className="mt-6 grid grid-cols-2 rounded-md border p-1 text-sm">
        {(["in", "up"] as const).map((currentMode) => (
          <button
            key={currentMode}
            type="button"
            disabled={loading}
            onClick={() => changeMode(currentMode)}
            className={cn(
              "rounded py-2 transition-colors",
              mode === currentMode
                ? "bg-accent font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
              loading && "cursor-not-allowed opacity-60",
            )}
          >
            {currentMode === "in" ? "Sign in" : "Register"}
          </button>
        ))}
      </div>

      {/* Form */}

      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {/* Full name */}

        {mode === "up" && (
          <label className="block text-sm">
            Full name
            <input
              name="name"
              type="text"
              autoComplete="name"
              required
              disabled={loading}
              className={cn(input, "mt-1.5")}
              placeholder="Your full name"
            />
          </label>
        )}

        {/* Email */}

        <label className="block text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            disabled={loading}
            className={cn(input, "mt-1.5")}
            placeholder="you@example.com"
          />
        </label>

        {/* Password */}

        <label className="block text-sm">
          <span className="flex items-center justify-between">
            <span>Password</span>

            {mode === "in" && (
              <button
                type="button"
                disabled={loading}
                onClick={(e) => {
                  if (API_MODE !== "api") {
                    toast.info("Password reset will be available when the backend is connected.");
                    return;
                  }
                  const field = e.currentTarget.form?.elements.namedItem("email");
                  const email = field instanceof HTMLInputElement ? field.value.trim() : "";
                  if (!email) {
                    toast.error("Enter your email address first.");
                    return;
                  }
                  void import("@/services/api")
                    .then((m) => m.requestPasswordReset(email))
                    .then((msg) => toast.success(msg));
                }}
                className="text-xs text-muted-foreground transition hover:text-foreground"
              >
                Forgot password?
              </button>
            )}
          </span>

          <input
            name="password"
            type="password"
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            required
            minLength={10}
            disabled={loading}
            className={cn(input, "mt-1.5")}
            placeholder="At least 10 characters"
          />
        </label>

        {/* Terms */}

        {mode === "up" && (
          <label className="flex items-start gap-2 text-sm text-muted-foreground">
            <input name="terms" type="checkbox" required disabled={loading} className="mt-1" />

            <span>
              I agree to the{" "}
              <Link to="/help" className="text-foreground underline underline-offset-2">
                terms and auction rules
              </Link>
              .
            </span>
          </label>
        )}

        {/* Error */}

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Submit */}

        <button
          type="submit"
          disabled={loading}
          className={cn(btn, "h-11 w-full", loading && "cursor-not-allowed opacity-60")}
        >
          {loading ? "Please wait..." : mode === "in" ? "Sign in" : "Create account"}
        </button>
      </form>

      {/* Demo note */}

      <p className="mt-6 text-xs leading-5 text-muted-foreground">
        {API_MODE === "api"
          ? "AUCTRA is a portfolio demo marketplace: accounts are real, payments are simulated. New accounts confirm their email with a 6-digit code or link."
          : "Preview only. Authentication is simulated locally. No real account is created, and passwords are not stored."}
      </p>
    </main>
  );
}
