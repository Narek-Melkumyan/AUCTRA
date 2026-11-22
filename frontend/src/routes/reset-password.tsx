import { useState, type FormEvent } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { btn, input, metaFor } from "@/components/account/AccountLayout";
import { resetPassword } from "@/services/api";

export const Route = createFileRoute("/reset-password")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s["token"] === "string" ? s["token"] : "",
  }),
  head: () => ({ meta: metaFor("Reset password", "Choose a new AUCTRA password.") }),
  component: ResetPassword,
});

function ResetPassword() {
  const { token } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    if (password !== String(f.get("confirm") ?? "")) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    void resetPassword(token, password)
      .then((r) => {
        if (!r.ok) return setError(r.error);
        setDone(true);
        toast.success("Password updated. Sign in with your new password.");
      })
      .finally(() => setLoading(false));
  };

  if (done) {
    return (
      <div className="mx-auto max-w-md px-4 py-20 text-center">
        <h1 className="font-display text-3xl">Password updated</h1>
        <p className="mt-4 text-sm text-muted-foreground">
          For your security, every device was signed out.
        </p>
        <Link to="/login" className={`${btn} mt-8`}>
          Sign in
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-md space-y-4 px-4 py-20">
      <h1 className="font-display text-3xl">Choose a new password</h1>
      <input
        name="password"
        type="password"
        required
        minLength={10}
        autoComplete="new-password"
        placeholder="At least 10 characters"
        className={input}
      />
      <input
        name="confirm"
        type="password"
        required
        minLength={10}
        autoComplete="new-password"
        placeholder="Repeat the password"
        className={input}
      />
      {error && <p className="text-sm text-live">{error}</p>}
      <button type="submit" disabled={loading || !token} className={`${btn} w-full`}>
        {loading ? "Saving…" : "Update password"}
      </button>
    </form>
  );
}
