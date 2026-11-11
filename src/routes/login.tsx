import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { btn, input, metaFor } from "@/components/account/AccountLayout";
import { Logo } from "@/components/layout/AppShell";
import { services } from "@/services";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/login")({
  head: () => ({ meta: metaFor("Sign in", "Sign in or create an AUCTRA account to bid, watch and sell.") }),
  component: Login,
});

function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();
  const submit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email") ?? "").trim();
    const pw = String(f.get("password") ?? "");
    if (!/^\S+@\S+\.\S+$/.test(email)) return setErr("Enter a valid email address.");
    if (pw.length < 8) return setErr("Password must be at least 8 characters.");
    if (mode === "up" && !String(f.get("name") ?? "").trim()) return setErr("Enter your full name.");
    if (mode === "up" && !f.get("terms")) return setErr("Please accept the terms to continue.");
    setErr(null);
    const name = String(f.get("name") ?? "");
    void (mode === "up" ? services.auth.register(name, email, pw) : services.auth.signIn(email, pw)).then((r) => {
      if (!r.ok) return setErr(r.error);
      toast.success(mode === "up" ? "Demo account created" : "Signed in (demo)");
      nav({ to: "/dashboard" });
    });
  };
  return (
    <div className="mx-auto grid min-h-[calc(100vh-8rem)] max-w-sm content-center px-4 py-12">
      <div className="mb-8"><Logo /></div>
      <h1 className="text-2xl font-medium tracking-tight">{mode === "in" ? "Sign in" : "Create your account"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{mode === "in" ? "Welcome back." : "Bid, watch and sell on AUCTRA."}</p>
      <div className="mt-6 grid grid-cols-2 rounded-md border p-1 text-sm">
        {(["in", "up"] as const).map((m) => <button key={m} type="button" onClick={() => { setMode(m); setErr(null); }} className={cn("rounded py-1.5", mode === m ? "bg-accent font-medium" : "text-muted-foreground")}>{m === "in" ? "Sign in" : "Register"}</button>)}
      </div>
      <form onSubmit={submit} className="mt-6 space-y-4" noValidate>
        {mode === "up" && <label className="block text-sm">Full name<input name="name" autoComplete="name" className={cn(input, "mt-1.5")} /></label>}
        <label className="block text-sm">Email<input name="email" type="email" autoComplete="email" className={cn(input, "mt-1.5")} /></label>
        <label className="block text-sm">
          <span className="flex justify-between">Password {mode === "in" && <button type="button" onClick={() => toast("Password reset needs the backend — not available in demo.")} className="text-xs text-muted-foreground hover:text-foreground">Forgot?</button>}</span>
          <input name="password" type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} className={cn(input, "mt-1.5")} />
        </label>
        {mode === "up" && <label className="flex items-start gap-2 text-sm text-muted-foreground"><input name="terms" type="checkbox" className="mt-0.5" /> I agree to the <Link to="/help" className="underline">terms and auction rules</Link>.</label>}
        {err && <p role="alert" className="text-sm text-live">{err}</p>}
        <button className={cn(btn, "h-10 w-full")}>{mode === "in" ? "Sign in" : "Create account"}</button>
      </form>
      <p className="mt-6 text-xs text-muted-foreground">Demo only: no account is created and the password isn't stored. Real sign-in will come from your backend.</p>
    </div>
  );
}
