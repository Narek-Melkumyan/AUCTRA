import { createFileRoute } from "@tanstack/react-router";
import { IS_API_MODE } from "@/lib/auction-store";
import { DemoMonitor } from "@/components/admin/DemoMonitor";
import { AdminDashboard } from "@/components/admin/AdminDashboard";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Admin dashboard — AUCTRA" },
      {
        name: "description",
        content:
          "Staff dashboard: analytics, users, sellers, auctions, moderation and notifications.",
      },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: () => (IS_API_MODE ? <AdminDashboard /> : <DemoMonitor />),
});
