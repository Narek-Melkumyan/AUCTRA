import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { btn, btnGhost, input } from "@/components/account/AccountLayout";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";

export const card = "rounded-2xl border bg-card";
export const th =
  "px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground";
export const td = "px-4 py-3 align-top";
export const select =
  "h-9 rounded-md border bg-background px-2 text-sm outline-none focus:border-ring";
export const btnSm =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-medium transition hover:bg-accent disabled:opacity-40";
export const btnDanger =
  "inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-live/40 px-3 text-xs font-medium text-live transition hover:bg-live/10 disabled:opacity-40";

export const errMsg = (e: unknown) =>
  e instanceof ApiError ? e.message : "Something went wrong. Please try again.";

export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn(card, "overflow-hidden", className)}>
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function StatCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className={cn(card, "p-5")}>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular sm:text-3xl">{value}</p>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const PILL: Record<string, string> = {
  LIVE: "bg-live/15 text-live",
  ACTIVE: "bg-success/15 text-success",
  VISIBLE: "bg-success/15 text-success",
  SENT: "bg-success/15 text-success",
  SOLD: "bg-success/15 text-success",
  COMPLETED: "bg-success/15 text-success",
  VERIFIED: "bg-success/15 text-success",
  SCHEDULED: "bg-primary/15 text-primary",
  PENDING_REVIEW: "bg-primary/15 text-primary",
  PENDING: "bg-primary/15 text-primary",
  OPEN: "bg-primary/15 text-primary",
  PENDING_PAYMENT: "bg-primary/15 text-primary",
  SUSPENDED: "bg-live/15 text-live",
  BANNED: "bg-live/25 text-live",
  HIDDEN: "bg-live/15 text-live",
  DELETED: "bg-live/25 text-live",
  FAILED: "bg-live/25 text-live",
  CANCELLED: "bg-secondary text-muted-foreground",
  high: "bg-live/25 text-live",
  medium: "bg-primary/15 text-primary",
  low: "bg-secondary text-muted-foreground",
};

export function Pill({ value }: { value: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        PILL[value] ?? "bg-secondary text-muted-foreground",
      )}
    >
      {value === "LIVE" && <span className="size-1.5 rounded-full bg-live animate-live" />}
      {value.replace(/_/g, " ").toLowerCase()}
    </span>
  );
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-5" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" />
      ))}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div className="p-8 text-center text-sm text-muted-foreground" role="alert">
      {errMsg(error)}
      {retry && (
        <button className="ml-2 underline" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function EmptyRow({ children }: { children: ReactNode }) {
  return <p className="p-8 text-center text-sm text-muted-foreground">{children}</p>;
}

/**
 * Wraps an admin mutation: toasts the outcome and refreshes the listed queries.
 * Every important action is also audit-logged server-side.
 */
export function useAdminAction<TArgs>(
  fn: (args: TArgs) => Promise<unknown>,
  opts: { success: string; invalidate: string[][] },
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(opts.success);
      for (const key of opts.invalidate) void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
}

/** Confirmation dialog that optionally asks for a reason (required for destructive actions). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  reasonLabel,
  reasonRequired = false,
  danger = false,
  pending = false,
  extra,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  reasonLabel?: string;
  reasonRequired?: boolean;
  danger?: boolean;
  pending?: boolean;
  extra?: ReactNode;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const invalid = reasonRequired && reason.trim().length < 3;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setReason("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogTitle>{title}</DialogTitle>
        {description && <DialogDescription>{description}</DialogDescription>}
        {reasonLabel && (
          <label className="block text-sm">
            {reasonLabel}
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={500}
              className={cn(input, "mt-1.5 h-auto py-2")}
            />
          </label>
        )}
        {extra}
        <DialogFooter className="gap-2">
          <button className={btnGhost} onClick={() => onOpenChange(false)}>
            Cancel
          </button>
          <button
            className={cn(btn, danger && "bg-live text-live-foreground")}
            disabled={invalid || pending}
            onClick={() => onConfirm(reason.trim())}
          >
            {pending ? "Working…" : confirmLabel}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Small helper: holds which confirm dialog is open and for what. */
export function useConfirm<T>() {
  const [target, setTarget] = useState<T | null>(null);
  return {
    target,
    open: (t: T) => setTarget(t),
    close: () => setTarget(null),
    props: { open: target !== null, onOpenChange: (o: boolean) => !o && setTarget(null) },
  };
}

export function Pager({
  page,
  total,
  limit,
  onPage,
}: {
  page: number;
  total: number;
  limit: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t px-5 py-3 text-sm text-muted-foreground">
      <span>
        Page {page} of {pages} · {total.toLocaleString()} total
      </span>
      <div className="flex gap-2">
        <button className={btnSm} disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className={btnSm} disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
