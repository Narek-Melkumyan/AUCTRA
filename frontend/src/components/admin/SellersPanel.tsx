import { useQuery } from "@tanstack/react-query";
import { adminApi, fmtDate } from "@/lib/api/admin";
import {
  ConfirmDialog,
  EmptyRow,
  ErrorState,
  Loading,
  Section,
  btnDanger,
  btnSm,
  useAdminAction,
  useConfirm,
} from "./shared";

export function SellersPanel({
  onViewAuctions,
}: {
  onViewAuctions: (id: string, label: string) => void;
}) {
  const q = useQuery({ queryKey: ["admin", "sellers"], queryFn: adminApi.sellerApplications });
  const sellers = useQuery({
    queryKey: ["admin", "users", { role: "SELLER" }],
    queryFn: () => adminApi.users({ role: "SELLER" }),
  });
  const inv = [
    ["admin", "sellers"],
    ["admin", "users"],
    ["admin", "analytics"],
  ];
  const decide = useAdminAction(
    (a: { userId: string; decision: "approve" | "reject"; reason?: string }) =>
      adminApi.decideSeller(a.userId, a.decision, a.reason),
    { success: "Decision saved; the applicant was notified", invalidate: inv },
  );
  const confirm = useConfirm<string>();

  return (
    <div className="space-y-6">
      <Section
        title="Seller applications"
        description="Approving grants the SELLER role (and the right to list)."
      >
        {q.isPending ? (
          <Loading rows={2} />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyRow>No pending applications.</EmptyRow>
        ) : (
          <ul className="divide-y">
            {q.data.map((s) => (
              <li key={s.userId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {s.businessName ?? s.user.profile?.displayName} ·{" "}
                    <span className="text-muted-foreground">{s.type.toLowerCase()}</span>
                  </p>
                  <p className="text-xs text-muted-foreground">
                    @{s.user.profile?.handle} · {s.user.email} · applied {fmtDate(s.createdAt)}
                  </p>
                </div>
                <button
                  className={btnSm}
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ userId: s.userId, decision: "approve" })}
                >
                  Approve
                </button>
                <button className={btnDanger} onClick={() => confirm.open(s.userId)}>
                  Reject
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Verified sellers"
        description="Open a seller's listings, or suspend them from the Users tab."
      >
        {sellers.isPending ? (
          <Loading rows={2} />
        ) : sellers.isError ? (
          <ErrorState error={sellers.error} />
        ) : sellers.data.items.length === 0 ? (
          <EmptyRow>No sellers yet.</EmptyRow>
        ) : (
          <ul className="divide-y">
            {sellers.data.items.map((u) => (
              <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{u.displayName}</p>
                  <p className="text-xs text-muted-foreground">
                    @{u.handle} · {u.auctions} listings · {u.status.toLowerCase()}
                  </p>
                </div>
                <button className={btnSm} onClick={() => onViewAuctions(u.id, `@${u.handle}`)}>
                  View auctions
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <ConfirmDialog
        {...confirm.props}
        title="Reject this seller application?"
        reasonLabel="Reason (sent to the applicant)"
        reasonRequired
        danger
        confirmLabel="Reject"
        pending={decide.isPending}
        onConfirm={(reason) => {
          const userId = confirm.target!;
          confirm.close();
          decide.mutate({ userId, decision: "reject", reason });
        }}
      />
    </div>
  );
}
