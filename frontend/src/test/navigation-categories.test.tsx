import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";

// These features exist only in API mode.
vi.mock("@/lib/auction-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/auction-store")>()),
  IS_API_MODE: true,
}));
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({
    children,
    to,
    search,
    ...rest
  }: {
    children: ReactNode;
    to: string;
    search?: Record<string, string>;
    className?: string;
  }) => (
    <a href={`${to}${search ? `?${new URLSearchParams(search)}` : ""}`} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
}));
const navigate = vi.hoisted(() => vi.fn());
const apiCalls = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/api/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/client")>()),
  api: vi.fn(async (path: string) => {
    apiCalls.push(path);
    return { items: [], total: 0, page: 1, limit: 24 };
  }),
}));
const categories = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/listings", async (orig) => {
  const real = await orig<typeof import("@/lib/api/listings")>();
  return { ...real, listingsApi: { ...real.listingsApi, categories } };
});

import { canOpenAdmin } from "@/lib/api/admin";
import { AccountLayout } from "@/components/account/AccountLayout";
import { setApiSession, type Profile } from "@/lib/demo-session";
import { useNavCategories } from "@/lib/api/categories";
import { ApiExplore } from "@/components/explore/ApiExplore";

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);
const profile = (permissions: string[]): Profile =>
  ({
    id: "u1",
    name: "Test",
    email: "user@example.com",
    permissions,
    roles: [],
  }) as unknown as Profile;

const TREE = [
  {
    slug: "cars",
    name: "Cars",
    description: null,
    activeAuctionCount: 37,
    attributes: [],
    subcategories: [
      {
        slug: "cars-classic",
        name: "Classic cars",
        description: null,
        activeAuctionCount: 9,
        attributes: [],
      },
    ],
  },
  {
    slug: "boats",
    name: "Boats",
    description: "Added by an administrator",
    activeAuctionCount: 2,
    attributes: [],
    subcategories: [],
  },
];

describe("admin navigation", () => {
  afterEach(() => act(() => setApiSession({ user: null })));

  it("is derived from server permissions only", () => {
    expect(canOpenAdmin(null)).toBe(false);
    expect(canOpenAdmin(profile(["bid:place", "auction:create"]))).toBe(false);
    expect(canOpenAdmin(profile(["analytics:read", "user:read:any"]))).toBe(true);
    expect(canOpenAdmin(profile(["chat:moderate", "report:handle"]))).toBe(true);
  });

  it("shows the Admin dashboard link to staff and hides it from users and guests", () => {
    const { rerender } = render(<AccountLayout title="Account">x</AccountLayout>);
    expect(screen.queryByText("Admin dashboard")).toBeNull(); // guest
    act(() => setApiSession({ user: profile(["bid:place"]) }));
    rerender(<AccountLayout title="Account">x</AccountLayout>);
    expect(screen.queryByText("Admin dashboard")).toBeNull(); // ordinary user
    expect(screen.getByText("Messages")).toBeInTheDocument();
    act(() => setApiSession({ user: profile(["analytics:read", "role:assign"]) }));
    rerender(<AccountLayout title="Account">x</AccountLayout>);
    expect(screen.getByText("Admin dashboard").closest("a")?.getAttribute("href")).toBe("/admin");
    act(() => setApiSession({ user: null })); // signed out
    rerender(<AccountLayout title="Account">x</AccountLayout>);
    expect(screen.queryByText("Admin dashboard")).toBeNull();
  });
});

describe("database categories", () => {
  beforeEach(() => {
    categories.mockReset().mockResolvedValue(TREE);
    apiCalls.length = 0;
  });

  it("uses PostgreSQL categories and counts, including admin-created ones", async () => {
    const { result } = renderHook(() => useNavCategories(), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((c) => [c.name, c.count, c.param])).toEqual([
      ["Cars", 37, "cars"],
      ["Boats", 2, "boats"],
    ]);
    expect(result.current[0]!.image).toBeTruthy();
    expect(result.current[1]!.image).toBeUndefined(); // lettered tile for new categories
  });

  it("Explore filters on the server with the selected category, and lists DB categories", async () => {
    render(<ApiExplore search={{ category: "cars-classic", status: "live" }} />, { wrapper });
    await screen.findByText("Boats (2)");
    expect(screen.getByRole("heading", { name: "Classic cars" })).toBeInTheDocument();
    await waitFor(() => expect(apiCalls.some((p) => p.startsWith("/auctions?"))).toBe(true));
    const q = new URLSearchParams(apiCalls.find((p) => p.startsWith("/auctions?"))!.split("?")[1]);
    expect(q.get("category")).toBe("cars-classic");
    expect(q.get("phase")).toBe("live");
    expect(q.get("limit")).toBe("24");
    fireEvent.click(screen.getByText("Boats (2)"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/explore",
      search: { category: "boats", status: "live" },
    });
  });
});
