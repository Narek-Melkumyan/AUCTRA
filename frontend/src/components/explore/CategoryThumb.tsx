import { cn } from "@/lib/utils";

/** Category artwork, or a lettered tile for categories without artwork (e.g. admin-created). */
export function CategoryThumb({
  name,
  image,
  className,
}: {
  name: string;
  image: string | undefined;
  className?: string;
}) {
  return image ? (
    <img src={image} alt="" loading="lazy" className={cn("rounded-md object-cover", className)} />
  ) : (
    <span
      aria-hidden
      className={cn(
        "grid place-items-center rounded-md bg-secondary text-sm font-semibold uppercase text-muted-foreground",
        className,
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}
