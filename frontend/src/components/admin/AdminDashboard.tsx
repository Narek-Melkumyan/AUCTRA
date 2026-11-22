import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ShieldAlert } from "lucide-react";
import { btn } from "@/components/account/AccountLayout";
import { useSession } from "@/lib/demo-session";
import { refreshMe } from "@/lib/api/account";
import { adminAccess } from "@/lib/api/admin";
import { cn } from "@/lib/utils";
import { OverviewPanel } from "./OverviewPanel";
import { UsersPanel } from "./UsersPanel";
import { SellersPanel } from "./SellersPanel";
import { AuctionsPanel } from "./AuctionsPanel";
import { ModerationPanel } from "./ModerationPanel";
import { NotificationsPanel } from "./NotificationsPanel";
import { AdminAssistantPanel } from "./AdminAssistantPanel";
import { OrdersPanel } from "./OrdersPanel";
import { CategoriesPanel } from "./CategoriesPanel";

type Tab =
  | "overview"
  | "users"
  | "sellers"
  | "auctions"
  | "orders"
  | "moderation"
  | "categories"
  | "notifications"
  | "assistant";

/**
 * Staff dashboard (API mode). Tabs are shown according to the signed-in user's
 * permissions, but that is only for UX: every request is authorised by the server.
 */
export function AdminDashboard() {
  const user = useSession((s) => s.user);
  const restored = useSession((s) => s.restored);
  const [tab, setTab] = useState<Tab>("overview");
  const [sellerFilter, setSellerFilter] = useState<{ id: string; label: string } | null>(null);

  // Permissions can change (role granted/revoked): refresh them when the dashboard opens.
  useEffect(() => {
    if (user) void refreshMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  if (!restored)
    return (
      <div className="mx-auto mt-16 h-40 max-w-[1440px] animate-pulse rounded-2xl bg-muted/40" />
    );
  if (!user)
    return (
      <Gate
        title="Staff sign-in required"
        body="Sign in with a staff account to open the admin dashboard."
      >
        <Link to="/login" className={btn}>
          Sign in
        </Link>
      </Gate>
    );
  const access = adminAccess(user.permissions);
  if (!access.any)
    return (
      <Gate
        title="You don't have access to the admin dashboard"
        body="This area is for AUCTRA staff (moderators and administrators)."
      >
        <Link to="/" className={btn}>
          Back to AUCTRA
        </Link>
      </Gate>
    );

  const tabs: [Tab, string, boolean][] = [
    ["overview", "Overview", access.analytics],
    ["users", "Users", access.users],
    ["sellers", "Sellers", access.sellers],
    ["auctions", "Auctions", access.auctions],
    ["orders", "Orders & disputes", access.orders || access.disputes],
    ["moderation", "Moderation", access.chat || access.reports],
    ["categories", "Categories", access.categories],
    ["notifications", "Notifications", access.notifications],
    ["assistant", "AI assistant", access.ai],
  ];
  const visible = tabs.filter(([, , ok]) => ok);
  const current = visible.some(([k]) => k === tab) ? tab : visible[0]![0];

  return (
    <div className="mx-auto max-w-[1440px] px-4 py-10 sm:px-6 lg:px-10">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">
        Staff console ·{" "}
        {user.roles
          ?.filter((r) => r !== "USER")
          .map((r) => r.replace("_", " ").toLowerCase())
          .join(" · ")}
      </p>
      <h1 className="mt-2 font-display text-4xl">Operations dashboard</h1>
      <div
        role="tablist"
        aria-label="Admin sections"
        className="mt-6 flex gap-1 overflow-x-auto border-b"
      >
        {visible.map(([k, label]) => (
          <button
            key={k}
            role="tab"
            aria-selected={current === k}
            onClick={() => setTab(k)}
            className={cn(
              "relative whitespace-nowrap px-4 py-3 text-sm font-medium text-muted-foreground transition hover:text-foreground",
              current === k && "text-foreground",
            )}
          >
            {label}
            {current === k && (
              <span className="absolute inset-x-3 bottom-0 h-0.5 rounded bg-primary" />
            )}
          </button>
        ))}
      </div>
      <div className="mt-6">
        {current === "overview" && <OverviewPanel access={access} />}
        {current === "users" && <UsersPanel access={access} me={user.id} />}
        {current === "sellers" && (
          <SellersPanel
            onViewAuctions={(id, label) => {
              setSellerFilter({ id, label });
              setTab("auctions");
            }}
          />
        )}
        {current === "auctions" && (
          <AuctionsPanel
            access={access}
            sellerFilter={sellerFilter}
            clearSeller={() => setSellerFilter(null)}
          />
        )}
        {current === "orders" && <OrdersPanel access={access} />}
        {current === "moderation" && <ModerationPanel access={access} />}
        {current === "categories" && <CategoriesPanel />}
        {current === "notifications" && <NotificationsPanel access={access} />}
        {current === "assistant" && <AdminAssistantPanel />}
      </div>
    </div>
  );
}

function Gate({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <ShieldAlert className="mx-auto size-9 text-muted-foreground" aria-hidden />
      <h1 className="mt-4 font-display text-3xl">{title}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{body}</p>
      <div className="mt-8">{children}</div>
    </div>
  );
}
