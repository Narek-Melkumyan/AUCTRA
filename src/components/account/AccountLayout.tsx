import { Link } from "@tanstack/react-router";
import { Bell, Gavel, Heart, LayoutDashboard, Package, Settings } from "lucide-react";
import { useSession } from "@/lib/demo-session";

const items = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/bids", label: "My bids", icon: Gavel },
  { to: "/watchlist", label: "Watchlist", icon: Heart },
  { to: "/orders", label: "Orders", icon: Package },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AccountLayout({ title, description, actions, children }: { title: string; description?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  const user = useSession((s) => s.user);
  return (
    <div className="mx-auto grid max-w-[1280px] gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[200px_1fr] lg:px-8 lg:py-10">
      <aside>
        <p className="mb-3 hidden text-xs text-muted-foreground lg:block">{user ? user.email : "Guest (demo)"}</p>
        <nav className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
          {items.map((i) => (
            <Link key={i.to} to={i.to} className="flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground" activeProps={{ className: "bg-accent text-foreground" }}>
              <i.icon className="size-4" /> {i.label}
            </Link>
          ))}
        </nav>
      </aside>
      <section className="min-w-0">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b pb-4">
          <div>
            <h1 className="text-2xl font-medium tracking-tight">{title}</h1>
            {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
          </div>
          {actions}
        </div>
        {children}
      </section>
    </div>
  );
}

export function Empty({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="text-sm font-medium">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-medium tabular">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const btn = "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40";
export const btnGhost = "inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-accent";
export const input = "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring";
export const metaFor = (title: string, description: string) => [
  { title: `${title} — AUCTRA` },
  { name: "description", content: description },
  { property: "og:title", content: `${title} — AUCTRA` },
  { property: "og:description", content: description },
  { property: "og:type", content: "website" },
  { name: "twitter:card", content: "summary" },
];
