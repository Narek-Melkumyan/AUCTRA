import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckCircle2, MailCheck, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { btn, btnGhost, input, metaFor } from "@/components/account/AccountLayout";
import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { useSession } from "@/lib/demo-session";
import { resendVerification, verifyEmailCode, verifyEmailLink } from "@/lib/api/account";
import { cn } from "@/lib/utils";

type Delivery = "sent" | "failed" | "dev" | "";

export const Route = createFileRoute("/verify-email")({
  validateSearch: (s: Record<string, unknown>) => ({
    token: typeof s["token"] === "string" ? s["token"] : "",
    delivery: (["sent", "failed", "dev"].includes(String(s["delivery"]))
      ? s["delivery"]
      : "") as Delivery,
  }),
  head: () => ({ meta: metaFor("Verify email", "Confirm your AUCTRA email address.") }),
  component: VerifyEmail,
});

function VerifyEmail() {
  const { token } = Route.useSearch();
  return token ? <LinkVerification token={token} /> : <CodeVerification />;
}

/** Opened from the emailed button. Verification is a POST so mail scanners can't consume it. */
function LinkVerification({ token }: { token: string }) {
  const [state, setState] = useState<"working" | "done" | "error">("working");
  const [message, setMessage] = useState("");
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    void verifyEmailLink(token).then((r) => {
      setState(r.ok ? "done" : "error");
      if (!r.ok) setMessage(r.error);
    });
  }, [token]);
  if (state === "done") return <Verified />;
  return (
    <Shell>
      {state === "working" ? (
        <>
          <h1 className="font-display text-3xl">Verifying…</h1>
          <p className="mt-3 text-sm text-muted-foreground" role="status">
            Confirming your email address.
          </p>
        </>
      ) : (
        <>
          <TriangleAlert className="mx-auto size-8 text-live" aria-hidden />
          <h1 className="mt-4 font-display text-3xl">Link didn't work</h1>
          <p className="mt-3 text-sm text-muted-foreground" role="alert">
            {message} Links expire after 15 minutes and work once — a newer email also replaces
            older ones.
          </p>
          <div className="mt-8 flex justify-center gap-2">
            <Link to="/verify-email" search={{ token: "", delivery: "" }} className={btn}>
              Enter a code instead
            </Link>
          </div>
        </>
      )}
    </Shell>
  );
}

function CodeVerification() {
  const { delivery } = Route.useSearch();
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [cooldown, setCooldown] = useState(delivery ? 60 : 0);
  const [deliveryState, setDeliveryState] = useState<Delivery>(delivery);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  if (done || user?.emailVerified) return <Verified />;

  const submit = async (value = code) => {
    if (busy) return;
    if (!/^\d{6}$/.test(value)) {
      setError("Enter all 6 digits.");
      return;
    }
    if (!user && !/^\S+@\S+\.\S+$/.test(email.trim())) {
      setError("Enter the email address the code was sent to.");
      return;
    }
    setBusy(true);
    setError(null);
    const r = await verifyEmailCode(value, user ? undefined : email.trim());
    setBusy(false);
    if (r.ok) {
      setDone(true);
      return;
    }
    setError(r.error);
    setCode("");
  };

  const resend = async () => {
    if (cooldown > 0 || busy) return;
    setBusy(true);
    const r = await resendVerification();
    setBusy(false);
    if (!r.ok) {
      toast.error(r.error);
      if (r.code === "RATE_LIMITED") setCooldown(60);
      return;
    }
    if (r.data.alreadyVerified) {
      setDone(true);
      return;
    }
    setError(null);
    setCode("");
    setCooldown(60);
    const d = r.data.email;
    setDeliveryState(d?.delivered ? "sent" : d?.providerConfigured ? "failed" : "dev");
    toast.success(
      d?.delivered ? "New code sent. Older codes and links no longer work." : "New code created.",
    );
  };

  return (
    <Shell>
      <MailCheck className="mx-auto size-8 text-primary" aria-hidden />
      <h1 className="mt-4 font-display text-3xl">Check your inbox</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {user ? (
          <>
            {deliveryState === "dev" ? "We created" : "We sent"} a 6-digit code and a verification
            link for <span className="font-medium text-foreground">{user.email}</span>. Use either
            one — both expire in 15 minutes.
          </>
        ) : (
          "Enter the 6-digit code from your verification email, or open the link in it."
        )}
      </p>
      <DeliveryNote state={deliveryState} />
      <form
        className="mt-8 space-y-5 text-left"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {!user && restored && (
          <label className="block text-sm">
            Email
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={cn(input, "mt-1.5")}
            />
          </label>
        )}
        <div className="flex justify-center">
          <InputOTP
            maxLength={6}
            value={code}
            onChange={(v) => {
              setCode(v.replace(/\D/g, ""));
              setError(null);
            }}
            onComplete={(v: string) => {
              if (user) void submit(v);
            }}
            inputMode="numeric"
            pattern="^[0-9]*$"
            autoFocus
            aria-label="6-digit verification code"
            disabled={busy}
          >
            <InputOTPGroup>
              {[0, 1, 2].map((i) => (
                <InputOTPSlot key={i} index={i} className="size-12 text-lg" />
              ))}
            </InputOTPGroup>
            <InputOTPSeparator />
            <InputOTPGroup>
              {[3, 4, 5].map((i) => (
                <InputOTPSlot key={i} index={i} className="size-12 text-lg" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        {error && (
          <p className="text-center text-sm text-live" role="alert">
            {error}
          </p>
        )}
        <button className={cn(btn, "h-11 w-full")} disabled={busy || code.length !== 6}>
          {busy ? "Checking…" : "Verify email"}
        </button>
      </form>
      {user ? (
        <div className="mt-6 text-sm text-muted-foreground">
          Didn't get it?{" "}
          <button
            onClick={() => void resend()}
            disabled={cooldown > 0 || busy}
            className="font-medium text-foreground underline-offset-4 hover:underline disabled:text-muted-foreground disabled:no-underline"
          >
            {cooldown > 0 ? `Resend in ${cooldown}s` : "Send a new code"}
          </button>
        </div>
      ) : (
        restored && (
          <p className="mt-6 text-sm text-muted-foreground">
            Need a new code?{" "}
            <Link to="/login" className="font-medium text-foreground hover:underline">
              Sign in
            </Link>{" "}
            and request one.
          </p>
        )
      )}
    </Shell>
  );
}

function DeliveryNote({ state }: { state: Delivery }) {
  if (state === "failed")
    return (
      <p
        className="mt-4 rounded-md border border-live/40 bg-live/5 p-3 text-xs text-live"
        role="alert"
      >
        We couldn't hand your email to our mail provider just now. Wait a minute and send a new
        code.
      </p>
    );
  if (state === "dev")
    return (
      <p className="mt-4 rounded-md border border-dashed p-3 text-xs text-muted-foreground">
        Email delivery isn't configured on this server (no <code>RESEND_API_KEY</code>), so nothing
        was sent. In local development the code and link are printed in the API server log.
      </p>
    );
  return null;
}

function Verified() {
  const nav = useNavigate();
  return (
    <Shell>
      <CheckCircle2 className="mx-auto size-9 text-success" aria-hidden />
      <h1 className="mt-4 font-display text-3xl">Email verified</h1>
      <p className="mt-3 text-sm text-muted-foreground">
        You're all set — you can now place bids and join auction chats.
      </p>
      <div className="mt-8 flex justify-center gap-2">
        <Link to="/live" className={btn}>
          Browse live auctions
        </Link>
        <button onClick={() => void nav({ to: "/dashboard" })} className={btnGhost}>
          Dashboard
        </button>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-md px-4 py-20 text-center">{children}</div>;
}
