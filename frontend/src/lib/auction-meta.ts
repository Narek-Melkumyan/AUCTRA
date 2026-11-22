import { notFound } from "@tanstack/react-router";
import { seedAuctions } from "@/lib/auctions";
import { IS_API_MODE } from "@/lib/auction-store";
import { API_URL } from "@/lib/api/client";

/**
 * Route loader helper for /room/$id and /item/$id: resolves the auction title for
 * <head> and 404s unknown ids. In API mode it asks the backend (also during SSR);
 * in demo mode it uses the bundled seed.
 */
export async function loadAuctionMeta(id: string): Promise<{ title: string; description: string }> {
  if (!IS_API_MODE) {
    const a = seedAuctions.find((x) => x.id === id);
    if (!a) throw notFound();
    return { title: a.title, description: a.description };
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound();
  let res: Response;
  try {
    res = await fetch(`${API_URL}/auctions/${id}`);
  } catch {
    // API unreachable: render the page shell; the client will retry.
    return { title: "Auction", description: "" };
  }
  if (res.status === 404) throw notFound();
  if (!res.ok) return { title: "Auction", description: "" };
  const body = (await res.json()) as { title?: string; description?: string };
  return { title: body.title ?? "Auction", description: body.description ?? "" };
}
