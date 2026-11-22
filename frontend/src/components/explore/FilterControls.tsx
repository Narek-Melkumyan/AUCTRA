import { cn } from "@/lib/utils";

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
        {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  );
}
export function Check({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-3 rounded-lg px-1 py-1.5 text-left hover:text-foreground"
    >
      <span
        className={cn(
          "grid size-4 place-items-center rounded border",
          on && "border-primary bg-primary",
        )}
      >
        {on && <span className="size-1.5 rounded-sm bg-primary-foreground" />}
      </span>
      <span className={on ? "text-foreground" : "text-muted-foreground"}>{label}</span>
    </button>
  );
}
