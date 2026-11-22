import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import {
  Bell,
  Gavel,
  Heart,
  LayoutDashboard,
  MapPin,
  MessageSquare,
  Package,
  Settings,
  ShieldCheck,
  Star,
} from "lucide-react";
import { canOpenAdmin } from "@/lib/api/admin";

import { useSession } from "@/lib/demo-session";
import { IS_API_MODE } from "@/lib/auction-store";

const baseItems = [
  { to: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { to: "/bids", label: "My bids", icon: Gavel },
  { to: "/watchlist", label: "Watchlist", icon: Heart },
  { to: "/favorites", label: "Favourites", icon: Star, api: true },
  { to: "/orders", label: "Orders", icon: Package },
  { to: "/addresses", label: "Address book", icon: MapPin, api: true },
  { to: "/messages", label: "Messages", icon: MessageSquare, api: true },
  { to: "/notifications", label: "Notifications", icon: Bell },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;
const adminItem = { to: "/admin", label: "Admin dashboard", icon: ShieldCheck } as const;

type AccountLayoutProps = {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
};

export function AccountLayout({ title, description, actions, children }: AccountLayoutProps) {
  const user = useSession((s) => s.user);

  return (
    <div className="mx-auto grid max-w-[1280px] grid-cols-1 gap-8 px-4 py-8 sm:px-6 lg:grid-cols-[200px_minmax(0,1fr)] lg:px-8 lg:py-10">
      <aside className="min-w-0">
        <p className="mb-3 hidden text-xs text-muted-foreground lg:block">
          {user ? user.email : IS_API_MODE ? "Guest" : "Guest (demo)"}
        </p>

        <nav className="no-scrollbar -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:flex-col lg:px-0">
          {[
            ...baseItems.filter((i) => !("api" in i) || IS_API_MODE),
            ...(IS_API_MODE && canOpenAdmin(user) ? [adminItem] : []),
          ].map((item) => {
            const Icon = item.icon;

            return (
              <Link
                key={item.to}
                to={item.to}
                className="flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-accent hover:text-foreground"
                activeProps={{
                  className: "bg-accent text-foreground",
                }}
              >
                <Icon className="size-4" />
                <span>{item.label}</span>
              </Link>
            );
          })}
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

type EmptyProps = {
  title: string;
  body: string;
  action?: ReactNode;
};

export function Empty({ title, body, action }: EmptyProps) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center">
      <p className="text-sm font-medium">{title}</p>

      <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{body}</p>

      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

type StatProps = {
  label: string;
  value: ReactNode;
  hint?: string;
};

export function Stat({ label, value, hint }: StatProps) {
  return (
    <div className="bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>

      <p className="mt-1 text-xl font-medium tabular-nums">{value}</p>

      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export const btn =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-40";

export const btnGhost =
  "inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition hover:bg-accent";

export const input =
  "h-10 w-full rounded-md border bg-background px-3 text-sm outline-none transition focus:border-ring";

export const metaFor = (title: string, description: string) => [
  { title: `${title} — AUCTRA` },
  { name: "description", content: description },
  { property: "og:title", content: `${title} — AUCTRA` },
  { property: "og:description", content: description },
  { property: "og:type", content: "website" },
  { name: "twitter:card", content: "summary" },
];
