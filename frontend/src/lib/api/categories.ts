/** Marketplace categories from PostgreSQL (API mode): names, tree and open-lot counts. */
import { useQuery } from "@tanstack/react-query";
import { categories as demoCategories, images } from "@/lib/auctions";
import { IS_API_MODE } from "@/lib/auction-store";
import { listingsApi, type CategoryNode } from "./listings";

export type { CategoryNode };

/**
 * Category tree with live counts. Refetched when the tab regains focus and every minute, so a
 * category an administrator adds or hides shows up without a deploy or a page reload.
 */
export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: listingsApi.categories,
    enabled: IS_API_MODE,
    staleTime: 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Artwork for the built-in top-level categories; new categories get a lettered tile. */
const ART: Record<string, string> = {
  cars: images.car,
  watches: images.watch,
  jewelry: images.jewelry,
  art: images.art,
  "real-estate": images.house,
  collectibles: images.antique,
  fashion: images.handbag,
  electronics: images.electronics,
};
export const categoryArt = (slug: string): string | undefined => ART[slug];

/** Finds a category or subcategory by slug, with its parent when it is a subcategory. */
export function findCategory(tree: CategoryNode[] | undefined, slug: string | undefined) {
  if (!tree || !slug) return undefined;
  for (const c of tree) {
    if (c.slug === slug) return { node: c, parent: undefined };
    const sub = c.subcategories.find((s) => s.slug === slug);
    if (sub) return { node: sub, parent: c };
  }
  return undefined;
}

export type NavCategory = {
  key: string;
  name: string;
  image: string | undefined;
  /** Open lots (live + upcoming). Demo mode: the illustrative catalogue number. */
  count: number;
  /** Explore search param: a slug in API mode, the display name in demo mode. */
  param: string;
};

/**
 * Top-level categories for menus and chips. API mode: straight from PostgreSQL with real
 * open-lot counts (admin changes appear on the next refetch). Demo mode: the static set.
 */
export function useNavCategories(): NavCategory[] {
  const q = useCategories();
  if (!IS_API_MODE)
    return demoCategories.map((c) => ({
      key: c.slug,
      name: c.name,
      image: c.image,
      count: c.count,
      param: c.name,
    }));
  return (q.data ?? []).map((c) => ({
    key: c.slug,
    name: c.name,
    image: categoryArt(c.slug),
    count: c.activeAuctionCount ?? 0,
    param: c.slug,
  }));
}
