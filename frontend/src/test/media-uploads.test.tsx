import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import type { ImageDto } from "@/lib/api/types";

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const api = vi.hoisted(() => ({
  images: vi.fn(),
  uploadImage: vi.fn(),
  replaceImage: vi.fn(),
  reorder: vi.fn(),
  setPrimary: vi.fn(),
  removeImage: vi.fn(),
}));
vi.mock("@/lib/api/listings", async (orig) => {
  const real = await orig<typeof import("@/lib/api/listings")>();
  return { ...real, listingsApi: { ...real.listingsApi, ...api } };
});

import { AuctionImage } from "@/components/auction/AuctionImage";
import { ListingPhotos } from "@/components/sell/ListingPhotos";
import { toPhoto, toRoom } from "@/lib/api/adapters";
import { ApiError } from "@/lib/api/client";
import { checkFile } from "@/lib/api/listings";
import { photoOf } from "@/lib/media";

const v = (variant: string, width: number, height: number) => ({
  url: `https://media.example.com/auctions/a/i/${variant}.webp`,
  width,
  height,
  bytes: width * 10,
});
function stored(id: string, position: number, over: Partial<ImageDto> = {}): ImageDto {
  return {
    id,
    url: v("full", 1600, 1067).url,
    type: "IMAGE",
    altText: null,
    position,
    isPrimary: position === 0,
    storage: "r2",
    width: 1600,
    height: 1067,
    mimeType: "image/webp",
    bytes: 1,
    variants: {
      thumbnail: v("thumbnail", 320, 213),
      card: v("card", 800, 533),
      full: v("full", 1600, 1067),
    },
    createdAt: "2026-11-15T00:00:00Z",
    updatedAt: "2026-11-15T00:00:00Z",
    ...over,
  };
}
const legacy: ImageDto = {
  ...stored("legacy", 0),
  url: "asset://watch",
  storage: "bundled",
  variants: null,
  width: null,
  height: null,
};

describe("image variants", () => {
  it("maps uploaded photos to their thumbnail/card/full URLs and real widths", () => {
    const p = toPhoto(stored("x", 0), "watches");
    expect(p.thumb).toMatch(/thumbnail\.webp$/);
    expect(p.card).toMatch(/card\.webp$/);
    expect(p.full).toMatch(/full\.webp$/);
    expect(p.widths).toEqual({ thumb: 320, card: 800, full: 1600 });
    expect([p.width, p.height]).toEqual([1600, 1067]);
  });

  it("keeps bundled/external images working with one URL for every size", () => {
    const p = toPhoto(legacy, "watches");
    expect(p.thumb).toBe(p.full);
    expect(p.full).not.toContain("asset://");
    expect(p.widths).toBeUndefined();
    expect(photoOf({ images: ["/a.jpg"] })).toEqual({
      thumb: "/a.jpg",
      card: "/a.jpg",
      full: "/a.jpg",
    });
    expect(photoOf({ images: [] })).toBeUndefined();
  });

  it("renders a lazy, sized <img> with a srcset so small slots never fetch the full file", () => {
    render(
      <AuctionImage photo={toPhoto(stored("x", 0), "")} size="thumb" sizes="56px" alt="Lot" />,
    );
    const img = screen.getByAltText("Lot") as HTMLImageElement;
    expect(img.getAttribute("src")).toMatch(/thumbnail\.webp$/);
    expect(img.getAttribute("srcset")).toBe(
      [
        "https://media.example.com/auctions/a/i/thumbnail.webp 320w",
        "https://media.example.com/auctions/a/i/card.webp 800w",
        "https://media.example.com/auctions/a/i/full.webp 1600w",
      ].join(", "),
    );
    expect(img.getAttribute("sizes")).toBe("56px");
    expect(img.getAttribute("loading")).toBe("lazy");
    expect(img.getAttribute("decoding")).toBe("async");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["1600", "1067"]);
  });

  it("shows a placeholder instead of a broken image when the file is missing", () => {
    render(<AuctionImage photo={toPhoto(stored("x", 0), "")} size="card" alt="Lot photo" />);
    fireEvent.error(screen.getByAltText("Lot photo"));
    expect(screen.queryByAltText("Lot photo")).toBeNull();
    expect(screen.getByRole("img", { name: "Lot photo" }).tagName).toBe("DIV");
  });

  it("lists each width once when a small original made equal-width variants", () => {
    const small = stored("s", 0, {
      variants: {
        thumbnail: v("thumbnail", 320, 240),
        card: v("card", 600, 450),
        full: v("full", 600, 450),
      },
    });
    render(<AuctionImage photo={toPhoto(small, "")} size="full" eager alt="Small" />);
    const img = screen.getByAltText("Small");
    expect(img.getAttribute("srcset")?.split(", ")).toHaveLength(2);
    expect(img.getAttribute("loading")).toBe("eager");
  });

  it("room view models carry photos for uploaded images", () => {
    const room = toRoom(
      {
        id: "a1",
        lotNumber: 1,
        title: "Lot",
        description: "",
        category: { slug: "watches", name: "Watches" },
        subcategory: null,
        condition: "EXCELLENT",
        location: { city: null, region: null, country: null },
        currency: "USD",
        startingPrice: { minor: "100", currency: "USD" },
        minIncrement: { minor: "10", currency: "USD" },
        minimumNextBid: { minor: "100", currency: "USD" },
        buyNowPrice: null,
        currentPrice: null,
        seller: { handle: null, displayName: "S", type: "DEALER", verified: true },
        media: [stored("x", 0), legacy],
        attributes: [],
        vehicle: null,
        watch: null,
        highestBid: null,
        result: null,
        watcherCount: 0,
        inspectionNotes: null,
        shippingNotes: null,
        viewer: null,
        createdAt: "2026-11-15T00:00:00Z",
        startsAt: "2026-11-15T00:00:00Z",
        endsAt: "2026-11-16T00:00:00Z",
        phase: "live",
        reserve: "none",
        version: 1,
        serverTime: "2026-11-15T00:00:00Z",
      } as unknown as Parameters<typeof toRoom>[0],
      null,
    );
    expect(room.images[0]).toMatch(/full\.webp$/);
    expect(photoOf(room, 0)?.thumb).toMatch(/thumbnail\.webp$/);
    expect(photoOf(room, 1)?.widths).toBeUndefined();
  });
});

describe("client-side file checks", () => {
  const file = (name: string, type: string, size = 1000) =>
    new File([new Uint8Array(size)], name, { type });
  it("accepts JPEG/PNG/WebP/AVIF and rejects other types, empty and oversized files", () => {
    expect(checkFile(file("a.jpg", "image/jpeg"))).toBeNull();
    expect(checkFile(file("a.avif", ""))).toBeNull();
    expect(checkFile(file("a.gif", "image/gif"))).toMatch(/JPEG, PNG, WebP or AVIF/);
    expect(checkFile(file("a.pdf", "application/pdf"))).toMatch(/JPEG, PNG, WebP or AVIF/);
    expect(checkFile(file("big.png", "image/png", 10 * 1024 * 1024 + 1))).toMatch(/10 MB/);
    expect(checkFile(file("empty.png", "image/png", 0))).toMatch(/empty/);
  });
});

describe("ListingPhotos", () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    toast.error.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });
  const pick = (files: File[]) =>
    fireEvent.change(screen.getByLabelText("Choose photos to upload"), { target: { files } });
  const jpg = (name: string) => new File([new Uint8Array(2000)], name, { type: "image/jpeg" });

  it("uploads each chosen photo and shows only what the server stored", async () => {
    api.images.mockResolvedValue([]);
    api.uploadImage
      .mockImplementationOnce(async (_id, _f, progress?: (n: number) => void) => {
        progress?.(0.5);
        return { images: [stored("i1", 0)], uploaded: [stored("i1", 0)], failed: [] };
      })
      .mockResolvedValueOnce({
        images: [stored("i1", 0), stored("i2", 1)],
        uploaded: [stored("i2", 1)],
        failed: [],
      });
    const onChange = vi.fn();
    render(<ListingPhotos auctionId="a1" onChange={onChange} />);
    await screen.findByText(/No photos yet/);
    await act(async () => pick([jpg("one.jpg"), jpg("two.jpg")]));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
    expect(api.uploadImage).toHaveBeenCalledTimes(2);
    expect(screen.getByText("Cover")).toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "i1" }),
      expect.objectContaining({ id: "i2" }),
    ]);
    // Gallery tiles use the 320 px variant.
    const tile = screen.getByAltText("Photo 2");
    expect(tile.getAttribute("src")).toMatch(/thumbnail\.webp$/);
  });

  it("uploads one file at a time so photos keep the order they were picked in", async () => {
    api.images.mockResolvedValue([]);
    let finishFirst!: () => void;
    api.uploadImage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = () =>
              resolve({ images: [stored("i1", 0)], uploaded: [stored("i1", 0)], failed: [] });
          }),
      )
      .mockResolvedValueOnce({
        images: [stored("i1", 0), stored("i2", 1)],
        uploaded: [stored("i2", 1)],
        failed: [],
      });
    render(<ListingPhotos auctionId="a1" />);
    await screen.findByText(/No photos yet/);
    await act(async () => pick([jpg("first.jpg"), jpg("second.jpg")]));
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalledTimes(1));
    expect((api.uploadImage.mock.calls[0]![1] as File).name).toBe("first.jpg");
    await new Promise((r) => setTimeout(r, 20));
    expect(api.uploadImage).toHaveBeenCalledTimes(1);
    await act(async () => finishFirst());
    await waitFor(() => expect(api.uploadImage).toHaveBeenCalledTimes(2));
    expect((api.uploadImage.mock.calls[1]![1] as File).name).toBe("second.jpg");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(2));
  });

  it("validates files before uploading", async () => {
    api.images.mockResolvedValue([]);
    render(<ListingPhotos auctionId="a1" />);
    await screen.findByText(/No photos yet/);
    await act(async () => pick([new File(["gif"], "anim.gif", { type: "image/gif" })]));
    expect(api.uploadImage).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/anim\.gif/));
  });

  it("shows server rejections without a pointless retry, and offers retry on network errors", async () => {
    api.images.mockResolvedValue([]);
    api.uploadImage
      .mockRejectedValueOnce(
        new ApiError(415, "UNSUPPORTED_IMAGE_TYPE", "Upload a JPEG, PNG, WebP or AVIF image."),
      )
      .mockRejectedValueOnce(
        new ApiError(0, "NETWORK_ERROR", "Upload failed: could not reach the server."),
      );
    render(<ListingPhotos auctionId="a1" />);
    await screen.findByText(/No photos yet/);
    await act(async () => pick([jpg("fake.jpg")]));
    await screen.findByText("Upload a JPEG, PNG, WebP or AVIF image.");
    expect(screen.queryByLabelText("Retry fake.jpg")).toBeNull();
    await act(async () => pick([jpg("flaky.jpg")]));
    await screen.findByText(/could not reach the server/);
    expect(screen.getByLabelText("Retry flaky.jpg")).toBeInTheDocument();
  });

  it("sets the cover, reorders and removes through the API", async () => {
    api.images.mockResolvedValue([stored("i1", 0), stored("i2", 1)]);
    api.setPrimary.mockResolvedValue([stored("i2", 0), stored("i1", 1)]);
    api.removeImage.mockResolvedValue([stored("i2", 0)]);
    render(<ListingPhotos auctionId="a1" />);
    await screen.findByAltText("Photo 2");
    const coverButtons = screen.getAllByLabelText("Set as cover");
    await act(async () => fireEvent.click(coverButtons[1]!));
    expect(api.setPrimary).toHaveBeenCalledWith("a1", "i2");
    await act(async () => fireEvent.click(screen.getAllByLabelText("Remove photo")[1]!));
    await act(async () => fireEvent.click(screen.getByText("Remove?")));
    expect(api.removeImage).toHaveBeenCalledWith("a1", "i1");
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(1));
  });
});
