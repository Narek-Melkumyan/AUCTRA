import { Star } from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";
import { useSession } from "@/lib/demo-session";
import { IS_API_MODE } from "@/lib/auction-store";
import { errText, useFavoriteIds, useToggleFavorite } from "@/lib/api/saved";
import { cn } from "@/lib/utils";

/**
 * Adds a lot to (or removes it from) the signed-in user's favourites — a personal
 * shortlist kept separately from the watchlist, which drives bid notifications.
 * API mode only; guests are sent to sign in.
 */
export function FavoriteButton({ id, className }: { id: string; className?: string }) {
  const user = useSession((s) => s.user);
  const navigate = useNavigate();
  const favs = useFavoriteIds();
  const toggle = useToggleFavorite();
  if (!IS_API_MODE) return null;
  const on = Boolean(favs.data?.includes(id));
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={on ? "Remove from favourites" : "Add to favourites"}
      title={on ? "Remove from favourites" : "Add to favourites"}
      disabled={toggle.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!user) {
          void navigate({ to: "/login" });
          return;
        }
        toggle.mutate(
          { id, on: !on },
          {
            onSuccess: () => toast.success(on ? "Removed from favourites" : "Saved to favourites"),
            onError: (err) => toast.error(errText(err, "Couldn't update your favourites.")),
          },
        );
      }}
      className={cn(
        "grid size-8 place-items-center rounded-md bg-background/90 transition hover:bg-background",
        className,
      )}
    >
      <Star className={cn("size-4", on ? "fill-gold text-gold" : "text-foreground")} />
    </button>
  );
}
