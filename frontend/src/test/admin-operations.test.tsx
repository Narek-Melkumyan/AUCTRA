import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}));

const api = vi.hoisted(() => ({
  orders: vi.fn(),
  disputes: vi.fn(),
  decideDispute: vi.fn(),
  categories: vi.fn(),
  createCategory: vi.fn(),
  updateCategory: vi.fn(),
}));
vi.mock("@/lib/api/admin", async (orig) => {
  const real = await orig<typeof import("@/lib/api/admin")>();
  return { ...real, adminApi: { ...real.adminApi, ...api } };
});

import { adminAccess, type AdminDispute } from "@/lib/api/admin";
import { OrdersPanel } from "@/components/admin/OrdersPanel";
import { CategoriesPanel } from "@/components/admin/CategoriesPanel";
import { toOrder } from "@/lib/api/adapters";

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>,
  );
const usd = (minor: string) => ({ minor, currency: "USD" });
const party = (h: string) => ({ id: h, email: `${h}@x.test`, displayName: h, handle: h });

beforeEach(() => Object.values(api).forEach((f) => f.mockReset()));

describe("admin access flags", () => {
  it("maps the new permissions to the categories, orders and disputes tabs", () => {
    const a = adminAccess(["category:manage", "order:read:any", "dispute:handle"]);
    expect([a.categories, a.orders, a.disputes]).toEqual([true, true, true]);
    const user = adminAccess(["bid:place"]);
    expect([user.any, user.categories, user.orders, user.disputes]).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});

describe("OrdersPanel", () => {
  const dispute: AdminDispute = {
    id: "d1",
    status: "OPEN",
    reason: "not_as_described",
    details: "Scratches",
    resolution: null,
    resolvedAt: null,
    createdAt: "2026-11-15T00:00:00Z",
    openedBy: party("buyer"),
    openedByRole: "buyer",
    handledBy: null,
    order: {
      id: "o1",
      orderNumber: "ORD-1",
      status: "DISPUTED",
      total: usd("120000"),
      auction: { id: "a1", title: "Gold watch" },
    },
  };

  it("shows real disputes and orders and requires an explanation to resolve", async () => {
    api.disputes.mockResolvedValue({ total: 1, page: 1, limit: 20, items: [dispute] });
    api.orders.mockResolvedValue({
      total: 1,
      page: 1,
      limit: 20,
      counts: { DISPUTED: 1 },
      items: [
        {
          id: "o1",
          orderNumber: "ORD-1",
          status: "DISPUTED",
          auction: { id: "a1", title: "Gold watch", lotNumber: 7 },
          buyer: party("buyer"),
          seller: party("seller"),
          hammerPrice: usd("120000"),
          buyerPremium: usd("0"),
          total: usd("120000"),
          demoCompletedAt: null,
          fulfillmentMethod: null,
          openDisputes: 1,
          createdAt: "2026-11-15T00:00:00Z",
        },
      ],
    });
    api.decideDispute.mockResolvedValue({ id: "d1", status: "RESOLVED_BUYER" });
    wrap(<OrdersPanel access={adminAccess(["order:read:any", "dispute:handle"])} />);
    await waitFor(() => expect(screen.getAllByText("ORD-1")).toHaveLength(2));
    expect(screen.getByText("open dispute")).toBeInTheDocument();
    expect(api.disputes).toHaveBeenCalledWith({ status: "OPEN", page: 1 });

    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Resolve for buyer" })),
    );
    const save = screen.getByRole("button", { name: "Save decision" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Decision \(shown to both parties\)/), {
      target: { value: "Damage was not disclosed." },
    });
    await act(async () => fireEvent.click(save));
    await waitFor(() =>
      expect(api.decideDispute).toHaveBeenCalledWith(
        "d1",
        "RESOLVED_BUYER",
        "Damage was not disclosed.",
      ),
    );
  });

  it("hides the dispute queue without dispute:handle", async () => {
    api.orders.mockResolvedValue({ total: 0, page: 1, limit: 20, counts: {}, items: [] });
    wrap(<OrdersPanel access={adminAccess(["order:read:any"])} />);
    expect(await screen.findByText("No orders yet.")).toBeInTheDocument();
    expect(screen.queryByText("Disputes")).toBeNull();
    expect(api.disputes).not.toHaveBeenCalled();
  });
});

describe("CategoriesPanel", () => {
  it("creates subcategories with a generated slug and cannot hide categories in use", async () => {
    api.categories.mockResolvedValue([
      {
        id: "c1",
        slug: "cars",
        name: "Cars",
        description: null,
        sortOrder: 1,
        isActive: true,
        auctionCount: 3,
        openAuctionCount: 2,
        subcategories: [
          {
            id: "c2",
            slug: "cars-classic",
            name: "Classic cars",
            description: null,
            sortOrder: 1,
            isActive: true,
            auctionCount: 0,
            openAuctionCount: 0,
          },
        ],
      },
    ]);
    api.createCategory.mockResolvedValue({ id: "n", slug: "cars-pre-war" });
    wrap(<CategoriesPanel />);
    await screen.findByText("Classic cars");
    const hide = screen.getAllByRole("button", { name: "Hide" });
    expect(hide[0]).toBeDisabled(); // Cars has open listings
    expect(hide[1]).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Pre-war" } });
    fireEvent.change(screen.getByLabelText("Parent"), { target: { value: "cars" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Add category" })));
    await waitFor(() =>
      expect(api.createCategory).toHaveBeenCalledWith(
        { name: "Pre-war", slug: "cars-pre-war", parentSlug: "cars" },
        expect.anything(),
      ),
    );
  });
});

describe("order statuses from the server", () => {
  it("shows disputed and cancelled orders instead of treating them as processing", () => {
    const base = {
      id: "o1",
      orderNumber: "ORD-1",
      role: "buyer" as const,
      auction: { id: "a1", title: "Lot", image: null },
      hammerPrice: usd("1000"),
      total: usd("1000"),
      createdAt: "2026-11-15T00:00:00Z",
    };
    expect(toOrder({ ...base, status: "DISPUTED" }).status).toBe("disputed");
    expect(toOrder({ ...base, status: "CANCELLED" }).status).toBe("cancelled");
    expect(toOrder({ ...base, status: "PENDING_PAYMENT" }).status).toBe("pending_payment");
  });
});
