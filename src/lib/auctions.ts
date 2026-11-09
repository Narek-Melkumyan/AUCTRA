import car from "@/assets/car.jpg";
import watch from "@/assets/watch.jpg";
import house from "@/assets/house.jpg";
import jewelry from "@/assets/jewelry.jpg";
import art from "@/assets/art.jpg";
import handbag from "@/assets/handbag.jpg";
import antique from "@/assets/antique.jpg";
import electronics from "@/assets/electronics.jpg";

export const images = { car, watch, house, jewelry, art, handbag, antique, electronics };

export type Category =
  | "Cars & Vehicles"
  | "Luxury Watches"
  | "Real Estate"
  | "Electronics"
  | "Jewelry & Diamonds"
  | "Art & Collectibles"
  | "Fashion & Luxury"
  | "Antiques";

export const categories: { name: Category; slug: string; image: string; count: number }[] = [
  { name: "Cars & Vehicles", slug: "cars", image: car, count: 3420 },
  { name: "Luxury Watches", slug: "watches", image: watch, count: 1286 },
  { name: "Real Estate", slug: "real-estate", image: house, count: 412 },
  { name: "Jewelry & Diamonds", slug: "jewelry", image: jewelry, count: 967 },
  { name: "Art & Collectibles", slug: "art", image: art, count: 2104 },
  { name: "Fashion & Luxury", slug: "fashion", image: handbag, count: 1830 },
  { name: "Antiques", slug: "antiques", image: antique, count: 744 },
  { name: "Electronics", slug: "electronics", image: electronics, count: 1592 },
];

export type Bid = { id: string; user: string; amount: number; at: number; mine?: boolean };
export type ChatMsg = { id: string; user: string; text: string; at: number; system?: boolean; mod?: boolean };
export type Status = "live" | "upcoming" | "ended";

export type Auction = {
  id: string;
  lot: string;
  title: string;
  category: Category;
  images: string[];
  location: string;
  condition: "New" | "Excellent" | "Very Good" | "Good" | "Fair";
  seller: string;
  sellerType: "Dealer" | "Private";
  verified: boolean;
  startBid: number;
  currentBid: number;
  increment: number;
  buyNow?: number;
  reserve: "met" | "not-met" | "none";
  reservePrice?: number;
  watchers: number;
  viewers: number;
  durationSec: number; // seconds from demo start until close
  startsInSec?: number; // for upcoming
  listedDaysAgo: number;
  specs: [string, string][];
  description: string;
  inspection: string;
  shipping: string;
};

const A = (a: Auction) => a;

export const seedAuctions: Auction[] = [
  A({
    id: "a1001", lot: "LOT 1001", title: "2021 Grand Tourer V12 Coupé", category: "Cars & Vehicles",
    images: [car, car, car], location: "Monaco", condition: "Excellent", seller: "Riviera Motors", sellerType: "Dealer", verified: true,
    startBid: 120000, currentBid: 168500, increment: 2500, buyNow: 245000, reserve: "not-met", reservePrice: 185000,
    watchers: 842, viewers: 318, durationSec: 420, listedDaysAgo: 6,
    specs: [["Mileage", "8,420 km"], ["Engine", "5.2L twin-turbo V12"], ["Transmission", "8-speed automatic"], ["Exterior", "Magnetic Silver"], ["Interior", "Obsidian leather"], ["Title", "Clean"]],
    description: "A single-owner grand tourer presented in a restrained metallic finish, with full dealer service history and both keys.",
    inspection: "Seller-provided notes: light stone chips on front splitter. No independent inspection has been verified by AUCTRA.",
    shipping: "Enclosed transport available within the EU. Collection from Monaco by appointment.",
  }),
  A({
    id: "a1002", lot: "LOT 1002", title: "Steel Diver Chronometer, Green Bezel", category: "Luxury Watches",
    images: [watch, watch], location: "Geneva, CH", condition: "Very Good", seller: "Atelier Horloger", sellerType: "Dealer", verified: true,
    startBid: 9000, currentBid: 14200, increment: 250, buyNow: 21000, reserve: "met",
    watchers: 1204, viewers: 452, durationSec: 95, listedDaysAgo: 3,
    specs: [["Case", "40mm Oystersteel"], ["Movement", "Automatic calibre"], ["Year", "2019"], ["Box & Papers", "Yes"], ["Water resistance", "300m"]],
    description: "A celebrated green-bezel diver with original box and papers. Bracelet stretch minimal.",
    inspection: "Seller-provided notes: hairline scratches on clasp. Authenticity not independently verified.",
    shipping: "Insured courier worldwide, signature required.",
  }),
  A({
    id: "a1003", lot: "LOT 1003", title: "Clifftop Villa with Infinity Pool", category: "Real Estate",
    images: [house, house], location: "Amalfi Coast, IT", condition: "Excellent", seller: "Costa Estates", sellerType: "Dealer", verified: true,
    startBid: 2400000, currentBid: 3150000, increment: 25000, reserve: "not-met", reservePrice: 3400000,
    watchers: 2310, viewers: 611, durationSec: 1500, listedDaysAgo: 14,
    specs: [["Bedrooms", "5"], ["Bathrooms", "6"], ["Interior", "620 m²"], ["Plot", "2,400 m²"], ["Built", "2018"]],
    description: "Architect-designed villa with panoramic sea views, glass-walled living spaces and a 22m infinity pool.",
    inspection: "Viewing by appointment. Survey documents available on request from the seller.",
    shipping: "Not applicable. Completion via notary within 60 days.",
  }),
  A({
    id: "a1004", lot: "LOT 1004", title: "Pear-Cut Diamond Rivière Necklace", category: "Jewelry & Diamonds",
    images: [jewelry, jewelry], location: "London, UK", condition: "Excellent", seller: "Maison Clair", sellerType: "Dealer", verified: true,
    startBid: 42000, currentBid: 58750, increment: 750, buyNow: 89000, reserve: "met",
    watchers: 688, viewers: 204, durationSec: 780, listedDaysAgo: 2,
    specs: [["Total weight", "18.4 ct"], ["Centre stone", "3.1 ct pear"], ["Metal", "18k white gold"], ["Certificate", "Seller-provided"]],
    description: "Floral cluster rivière culminating in a pear-cut drop.",
    inspection: "Grading report supplied by seller; not verified by AUCTRA.",
    shipping: "Insured courier, or collection in Mayfair.",
  }),
  A({
    id: "a1005", lot: "LOT 1005", title: "Abstract Composition No. 12, Oil on Canvas", category: "Art & Collectibles",
    images: [art, art], location: "New York, US", condition: "Very Good", seller: "Hartwell Gallery", sellerType: "Dealer", verified: true,
    startBid: 18000, currentBid: 26400, increment: 400, reserve: "none",
    watchers: 431, viewers: 146, durationSec: 1100, listedDaysAgo: 8,
    specs: [["Medium", "Oil on canvas"], ["Size", "120 × 95 cm"], ["Frame", "Gilded, period"], ["Provenance", "Private collection"]],
    description: "Expressive mid-century abstraction in a carved gilt frame.",
    inspection: "Minor craquelure lower left, per seller.",
    shipping: "Crated art shipping quoted on request.",
  }),
  A({
    id: "a1006", lot: "LOT 1006", title: "Quilted Leather Top-Handle Bag, Cognac", category: "Fashion & Luxury",
    images: [handbag, handbag], location: "Paris, FR", condition: "New", seller: "Lena V.", sellerType: "Private", verified: false,
    startBid: 1800, currentBid: 3150, increment: 50, buyNow: 4900, reserve: "none",
    watchers: 377, viewers: 98, durationSec: 640, listedDaysAgo: 1,
    specs: [["Material", "Lambskin"], ["Hardware", "Gold-tone"], ["Dimensions", "26 × 18 × 10 cm"], ["Dust bag", "Included"]],
    description: "Unused top-handle bag with detachable shoulder strap.",
    inspection: "Private seller, not yet verified.",
    shipping: "Tracked shipping across EU.",
  }),
  A({
    id: "a1007", lot: "LOT 1007", title: "Louis XV Carved Walnut Cabinet", category: "Antiques",
    images: [antique, antique], location: "Lyon, FR", condition: "Good", seller: "Maison Duret", sellerType: "Dealer", verified: true,
    startBid: 3200, currentBid: 4650, increment: 100, reserve: "met",
    watchers: 212, viewers: 61, durationSec: 1800, listedDaysAgo: 11,
    specs: [["Period", "c. 1780"], ["Wood", "Walnut"], ["Hardware", "Original brass"], ["Size", "110 × 52 × 120 cm"]],
    description: "Two-door cabinet with rocaille carving and original escutcheons.",
    inspection: "Restoration to rear feet noted by seller.",
    shipping: "White-glove delivery available.",
  }),
  A({
    id: "a1008", lot: "LOT 1008", title: "Rangefinder Camera & Studio Headphones Set", category: "Electronics",
    images: [electronics, electronics], location: "Berlin, DE", condition: "Excellent", seller: "Kurt H.", sellerType: "Private", verified: true,
    startBid: 900, currentBid: 1420, increment: 25, buyNow: 2100, reserve: "none",
    watchers: 156, viewers: 47, durationSec: 300, listedDaysAgo: 4,
    specs: [["Camera", "Rangefinder, 35mm f/2"], ["Headphones", "Planar magnetic"], ["Accessories", "Strap, cables, case"]],
    description: "A collector's pairing in excellent working condition.",
    inspection: "Seller reports full function tested.",
    shipping: "Tracked shipping worldwide.",
  }),
  A({
    id: "a1009", lot: "LOT 1009", title: "Vintage Gold Dress Watch, 1962", category: "Luxury Watches",
    images: [watch], location: "Milan, IT", condition: "Good", seller: "Orologi Bianchi", sellerType: "Dealer", verified: true,
    startBid: 3200, currentBid: 3200, increment: 100, reserve: "none",
    watchers: 98, viewers: 0, durationSec: 7200, startsInSec: 3600, listedDaysAgo: 0,
    specs: [["Case", "34mm 18k gold"], ["Movement", "Manual wind"], ["Year", "1962"]],
    description: "Elegant manual-wind dress watch with original dial.",
    inspection: "Serviced 2024 per seller.",
    shipping: "Insured courier.",
  }),
  A({
    id: "a1010", lot: "LOT 1010", title: "Coastal Penthouse, Sea-View Terrace", category: "Real Estate",
    images: [house], location: "Marbella, ES", condition: "Very Good", seller: "Sol Properties", sellerType: "Dealer", verified: true,
    startBid: 1100000, currentBid: 1100000, increment: 10000, reserve: "not-met", reservePrice: 1350000,
    watchers: 540, viewers: 0, durationSec: 10800, startsInSec: 7200, listedDaysAgo: 0,
    specs: [["Bedrooms", "3"], ["Terrace", "140 m²"]],
    description: "Top-floor penthouse moments from the marina.",
    inspection: "Viewings by appointment.",
    shipping: "Not applicable.",
  }),
];

export const fmt = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : `$${n.toLocaleString("en-US")}`;
export const fmtFull = (n: number) => `$${n.toLocaleString("en-US")}`;

export const collections = [
  { name: "Luxury Garage", image: car, blurb: "Grand tourers, supercars and rare classics." },
  { name: "Rare Timepieces", image: watch, blurb: "Reference watches from independent dealers." },
  { name: "Modern Living", image: house, blurb: "Architect-designed homes worldwide." },
  { name: "Collector's Vault", image: art, blurb: "Fine art, antiques and curiosities." },
  { name: "Fine Jewelry", image: jewelry, blurb: "Diamonds and signed pieces." },
];

/** Demo fee model: 10% buyer premium, capped at $25,000 + flat $49 platform fee. */
export function buyerFees(hammer: number) {
  const premium = Math.min(Math.round(hammer * 0.1), 25000);
  const platform = 49;
  return { premium, platform, total: hammer + premium + platform };
}
