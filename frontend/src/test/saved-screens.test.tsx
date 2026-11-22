import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { AuctionDto } from "@/lib/api/types";

// Address book and favourites exist only in API mode.
vi.mock("@/lib/auction-store", async (orig) => ({
  ...(await orig<typeof import("@/lib/auction-store")>()),
  IS_API_MODE: true,
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children, to, ...rest }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => navigate,
  useParams: () => ({ id: "l1" }),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

/** In-memory stand-in for the server, recording every call. */
type Call = { path: string; method: string; body?: unknown };
const server = vi.hoisted(() => ({
  calls: [] as Call[],
  handler: (_c: { path: string; method: string; body?: unknown }): unknown => undefined,
}));
vi.mock("@/lib/api/client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api/client")>()),
  api: vi.fn(async (path: string, opts: { method?: string; body?: unknown } = {}) => {
    const call = { path, method: opts.method ?? "GET", body: opts.body };
    server.calls.push(call);
    return server.handler(call);
  }),
}));

import { ApiError } from "@/lib/api/client";
import { setApiSession, type Profile } from "@/lib/demo-session";
import { addressProblems, cleanAddress, type SavedAddress } from "@/lib/api/saved";
import { Route as AddressesRoute } from "@/routes/addresses";
import { Route as FavoritesRoute } from "@/routes/favorites";
import { FavoriteButton } from "@/components/auction/FavoriteButton";
import { AccountLayout } from "@/components/account/AccountLayout";
import { DemoCheckout } from "@/components/checkout/DemoCheckout";

const Addresses = AddressesRoute.options.component as () => ReactNode;
const Favorites = FavoritesRoute.options.component as () => ReactNode;

const user = {
  id: "u1",
  name: "Ada Buyer",
  email: "ada@example.com",
  permissions: [],
  roles: [],
} as unknown as Profile;

function renderPage(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const addr = (over: Partial<SavedAddress>): SavedAddress => ({
  id: "a1",
  type: "SHIPPING",
  label: "Home",
  fullName: "Ada Buyer",
  line1: "1 Main Street",
  line2: null,
  city: "Springfield",
  region: null,
  postalCode: "12345",
  country: "US",
  phone: null,
  isDefault: true,
  createdAt: "2026-11-20T00:00:00Z",
  updatedAt: "2026-11-20T00:00:00Z",
  ...over,
});

function lot(id: string, title: string): AuctionDto {
  const now = Date.now();
  return {
    id,
    auctionId: id,
    lotNumber: 1001,
    title,
    description: "",
    version: 1,
    status: "LIVE",
    phase: "live",
    isAcceptingBids: true,
    startsAt: new Date(now - 3_600_000).toISOString(),
    endsAt: new Date(now + 3_600_000).toISOString(),
    currentPrice: { minor: "500000", currency: "USD" },
    minimumNextBid: { minor: "510000", currency: "USD" },
    bidCount: 3,
    reserve: "none",
    highestBidderAlias: null,
    serverTime: new Date(now).toISOString(),
    category: { slug: "watches", name: "Watches" },
    subcategory: null,
    condition: "EXCELLENT",
    location: { city: "Geneva", region: null, country: "CH" },
    currency: "USD",
    startingPrice: { minor: "100000", currency: "USD" },
    minIncrement: { minor: "10000", currency: "USD" },
    buyNowPrice: null,
    seller: { handle: "dealer", displayName: "Dealer", type: "BUSINESS", verified: true },
    media: [],
    attributes: [],
    vehicle: null,
    watch: null,
    highestBid: null,
    result: null,
    watcherCount: 0,
    inspectionNotes: null,
    shippingNotes: null,
    conditionNotes: null,
    fulfillmentMethod: "SHIPPING",
    viewer: null,
    createdAt: new Date(now).toISOString(),
  };
}

beforeEach(() => {
  server.calls = [];
  server.handler = () => undefined;
  toast.success.mockReset();
  toast.error.mockReset();
  navigate.mockReset();
  act(() => setApiSession({ user, restored: true }));
});
afterEach(() => act(() => setApiSession({ user: null })));

describe("address helpers", () => {
  it("trims input, upper-cases the country and drops blank optional fields", () => {
    expect(
      cleanAddress({
        type: "SHIPPING",
        label: "  ",
        fullName: " Ada ",
        line1: " 1 Main St ",
        line2: "",
        city: " Paris ",
        country: "fr",
        phone: " +33 1 ",
      }),
    ).toEqual({
      type: "SHIPPING",
      fullName: "Ada",
      line1: "1 Main St",
      city: "Paris",
      country: "FR",
      phone: "+33 1",
      isDefault: false,
    });
  });

  it("mirrors the server's validation rules", () => {
    const ok = { type: "SHIPPING" as const, fullName: "A", line1: "B", city: "C", country: "US" };
    expect(addressProblems(ok)).toEqual({});
    expect(Object.keys(addressProblems({ ...ok, fullName: " ", city: "" }))).toEqual([
      "fullName",
      "city",
    ]);
    expect(addressProblems({ ...ok, country: "USA" }).country).toBeDefined();
    expect(addressProblems({ ...ok, phone: "call me" }).phone).toBeDefined();
  });
});

describe("account navigation", () => {
  it("links to Favourites and Address book in API mode", () => {
    render(<AccountLayout title="Account">x</AccountLayout>);
    expect(screen.getByRole("link", { name: /Favourites/ })).toHaveAttribute("href", "/favorites");
    expect(screen.getByRole("link", { name: /Address book/ })).toHaveAttribute(
      "href",
      "/addresses",
    );
  });
});

describe("Address book screen", () => {
  it("asks guests to sign in and does not call the API", () => {
    act(() => setApiSession({ user: null }));
    renderPage(<Addresses />);
    expect(screen.getByText("Sign in to manage your addresses")).toBeInTheDocument();
    expect(server.calls).toEqual([]);
  });

  it("lists saved addresses from the server, default first", async () => {
    server.handler = ({ path }) =>
      path === "/me/addresses"
        ? [addr({}), addr({ id: "a2", label: "Office", line1: "9 Work Road", isDefault: false })]
        : undefined;
    renderPage(<Addresses />);
    const list = await screen.findByRole("list", { name: "Saved addresses" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByText("Default")).toBeInTheDocument();
    expect(within(cards[1]!).getByText(/9 Work Road/)).toBeInTheDocument();
    expect(screen.getByText(/2 saved addresses/)).toBeInTheDocument();
  });

  it("validates, then creates an address (the first one becomes the default)", async () => {
    let saved: SavedAddress[] = [];
    server.handler = ({ path, method, body }) => {
      if (method === "POST") {
        saved = [addr({ ...(body as Partial<SavedAddress>), id: "new" })];
        return saved[0];
      }
      if (path === "/me/addresses") return saved;
      return undefined;
    };
    renderPage(<Addresses />);
    await screen.findByText("No saved addresses yet");
    fireEvent.click(screen.getAllByRole("button", { name: /Add address/ })[0]!);
    const form = screen.getByRole("form", { name: "New address" });
    expect(within(form).getByLabelText(/Full name/)).toHaveValue("Ada Buyer");

    fireEvent.click(within(form).getByRole("button", { name: "Save address" }));
    expect(await within(form).findByText("Enter the street address.")).toBeInTheDocument();
    expect(server.calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.change(within(form).getByLabelText(/Street address/), {
      target: { value: "10 Rue de Rivoli" },
    });
    fireEvent.change(within(form).getByLabelText(/^City/), { target: { value: "Paris" } });
    fireEvent.change(within(form).getByLabelText(/^Country/), { target: { value: "FR" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save address" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Address saved"));
    expect(server.calls.find((c) => c.method === "POST")?.body).toEqual({
      type: "SHIPPING",
      fullName: "Ada Buyer",
      line1: "10 Rue de Rivoli",
      city: "Paris",
      country: "FR",
      isDefault: true,
    });
    expect(await screen.findByText(/10 Rue de Rivoli/)).toBeInTheDocument();
  });

  it("edits an address and clears optional fields left blank", async () => {
    server.handler = ({ path, method }) => {
      if (method === "PATCH") return addr({});
      if (path === "/me/addresses") return [addr({ line2: "Apt 4", phone: "+1 555" })];
      return undefined;
    };
    renderPage(<Addresses />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit Home address" }));
    const form = screen.getByRole("form", { name: "Edit address" });
    fireEvent.change(within(form).getByLabelText(/Apartment/), { target: { value: "" } });
    fireEvent.change(within(form).getByLabelText(/^City/), { target: { value: "Shelbyville" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Address updated"));
    const patch = server.calls.find((c) => c.method === "PATCH")!;
    expect(patch.path).toBe("/me/addresses/a1");
    expect(patch.body).toMatchObject({ city: "Shelbyville", line2: null, phone: "+1 555" });
  });

  it("confirms before deleting and reports server errors", async () => {
    server.handler = ({ method, path }) => {
      if (method === "DELETE") throw new ApiError(404, "NOT_FOUND", "Address not found.");
      if (path === "/me/addresses") return [addr({})];
      return undefined;
    };
    renderPage(<Addresses />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Home address" }));
    expect(server.calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Address not found."));
    expect(server.calls.find((c) => c.method === "DELETE")?.path).toBe("/me/addresses/a1");
  });
});

describe("Favourites screen", () => {
  it("shows starred lots loaded from the server, newest first", async () => {
    server.handler = ({ path }) => {
      if (path === "/me/favorites")
        return [
          { auctionId: "l2", createdAt: "2026-11-21T00:00:00Z" },
          { auctionId: "l1", createdAt: "2026-11-20T00:00:00Z" },
          { auctionId: "gone", createdAt: "2026-11-19T00:00:00Z" },
        ];
      if (path === "/auctions/l1") return lot("l1", "Omega Seamaster");
      if (path === "/auctions/l2") return lot("l2", "Rolex Submariner");
      if (path === "/auctions/gone") throw new ApiError(404, "NOT_FOUND", "Auction not found.");
      return undefined;
    };
    renderPage(<Favorites />);
    const list = await screen.findByRole("list", { name: "Favourite lots" });
    const titles = within(list)
      .getAllByRole("link")
      .map((a) => a.textContent)
      .filter((t) => t && /Rolex|Omega/.test(t));
    expect(titles).toEqual(["Rolex Submariner", "Omega Seamaster"]);
    // A withdrawn lot is skipped instead of breaking the page.
    expect(within(list).getAllByRole("article")).toHaveLength(2);
  });

  it("shows an empty state when nothing is starred", async () => {
    server.handler = ({ path }) => (path === "/me/favorites" ? [] : undefined);
    renderPage(<Favorites />);
    expect(await screen.findByText("No favourites yet")).toBeInTheDocument();
  });
});

describe("FavoriteButton", () => {
  it("stars and un-stars a lot through the API", async () => {
    let favs: { auctionId: string; createdAt: string }[] = [];
    server.handler = ({ path, method }) => {
      if (method === "PUT") favs = [{ auctionId: "l1", createdAt: "" }];
      if (method === "DELETE") favs = [];
      if (path === "/me/favorites") return favs;
      return {};
    };
    renderPage(<FavoriteButton id="l1" />);
    const btn = await screen.findByRole("button", { name: "Add to favourites" });
    await waitFor(() => expect(server.calls.some((c) => c.path === "/me/favorites")).toBe(true));
    fireEvent.click(btn);
    expect(await screen.findByRole("button", { name: "Remove from favourites" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(server.calls.find((c) => c.method === "PUT")?.path).toBe("/me/favorites/l1");
    fireEvent.click(screen.getByRole("button", { name: "Remove from favourites" }));
    expect(await screen.findByRole("button", { name: "Add to favourites" })).toBeInTheDocument();
    expect(server.calls.find((c) => c.method === "DELETE")?.path).toBe("/me/favorites/l1");
  });

  it("reverts the optimistic star when the server refuses", async () => {
    server.handler = ({ path, method }) => {
      if (method === "PUT") throw new ApiError(404, "NOT_FOUND", "Auction not found.");
      if (path === "/me/favorites") return [];
      return undefined;
    };
    renderPage(<FavoriteButton id="l1" />);
    await waitFor(() => expect(server.calls.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Add to favourites" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Auction not found."));
    expect(screen.getByRole("button", { name: "Add to favourites" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("sends guests to sign in instead of calling the API", () => {
    act(() => setApiSession({ user: null }));
    renderPage(<FavoriteButton id="l1" />);
    fireEvent.click(screen.getByRole("button", { name: "Add to favourites" }));
    expect(navigate).toHaveBeenCalledWith({ to: "/login" });
    expect(server.calls).toEqual([]);
  });
});

describe("checkout and the address book", () => {
  it("pre-fills the default shipping address and offers the other saved ones", async () => {
    const usd = (minor: string) => ({ minor, currency: "USD" });
    server.handler = ({ path }) => {
      if (path === "/checkout/l1")
        return {
          orderId: "o1",
          orderNumber: "AUC-1001",
          status: "PENDING_PAYMENT",
          simulated: true,
          completed: false,
          demoCompletedAt: null,
          auction: {
            id: "l1",
            title: "Rolex Submariner",
            lotNumber: 1001,
            image: null,
            categorySlug: "watches",
            shippingNotes: null,
          },
          hammerPrice: usd("500000"),
          buyerPremium: usd("50000"),
          tax: usd("0"),
          shipping: usd("0"),
          total: usd("550000"),
          fulfillmentMethod: "SHIPPING",
          deliveryOptions: [
            {
              key: "INSURED_SHIPPING",
              label: "Insured shipping",
              price: usd("0"),
              needsAddress: true,
            },
          ],
        };
      if (path === "/me/addresses")
        return [
          addr({ id: "b1", type: "BILLING", label: "Billing", line1: "7 Bank St" }),
          addr({ id: "s1", line1: "1 Main Street", isDefault: true }),
          addr({ id: "s2", label: "Cabin", line1: "5 Lake Rd", city: "Tahoe", isDefault: false }),
        ];
      return undefined;
    };
    renderPage(<DemoCheckout />);
    const street = await screen.findByLabelText("Address");
    await waitFor(() => expect(street).toHaveValue("1 Main Street"));
    const picker = screen.getByLabelText(/Saved address/) as HTMLSelectElement;
    // Shipping addresses only, plus "Enter a different address".
    expect([...picker.options].map((o) => o.value)).toEqual(["s1", "s2", ""]);
    fireEvent.change(picker, { target: { value: "s2" } });
    expect(screen.getByLabelText("Address")).toHaveValue("5 Lake Rd");
    expect(screen.getByLabelText("City")).toHaveValue("Tahoe");
  });
});
