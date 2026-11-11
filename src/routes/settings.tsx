import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { AccountLayout, Empty, btn, btnGhost, input, metaFor } from "@/components/account/AccountLayout";
import { signOut, updateProfile, useSession, type Profile } from "@/lib/demo-session";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: metaFor("Profile settings", "Manage your AUCTRA profile and notification preferences.") }),
  component: Settings,
});

function Settings() {
  const user = useSession((s) => s.user);
  const nav = useNavigate();
  if (!user) return <AccountLayout title="Settings"><Empty title="Sign in to edit your profile" body="Settings are saved in this browser for the demo." action={<Link to="/login" className={btn}>Sign in</Link>} /></AccountLayout>;
  const save = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get("name") ?? "").trim();
    if (!name) { toast.error("Name can't be empty."); return; }
    updateProfile({ name, phone: String(f.get("phone") ?? ""), country: String(f.get("country") ?? "") });
    toast.success("Profile saved");
  };
  const toggles: [keyof Profile, string][] = [["outbidAlerts", "Outbid alerts"], ["endingAlerts", "Ending-soon reminders for watched lots"], ["emailAlerts", "Email summaries"]];
  return (
    <AccountLayout title="Settings" description="Demo profile stored in this browser.">
      <form key={user.email} onSubmit={save} className="max-w-xl space-y-4">
        <h2 className="text-sm font-medium">Profile</h2>
        <label className="block text-sm">Full name<input name="name" defaultValue={user.name} className={cn(input, "mt-1.5")} /></label>
        <label className="block text-sm">Email<input value={user.email} disabled className={cn(input, "mt-1.5 opacity-60")} /></label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">Phone<input name="phone" defaultValue={user.phone} className={cn(input, "mt-1.5")} /></label>
          <label className="block text-sm">Country<input name="country" defaultValue={user.country} className={cn(input, "mt-1.5")} /></label>
        </div>
        <button className={btn}>Save changes</button>
      </form>
      <div className="mt-10 max-w-xl">
        <h2 className="mb-3 text-sm font-medium">Notifications</h2>
        <ul className="divide-y rounded-lg border bg-card">
          {toggles.map(([k, l]) => (
            <li key={k} className="flex items-center justify-between p-3 text-sm">
              <span>{l}</span>
              <button role="switch" aria-checked={!!user[k]} aria-label={l} onClick={() => updateProfile({ [k]: !user[k] })} className={cn("relative h-5 w-9 rounded-full transition", user[k] ? "bg-primary" : "bg-muted")}>
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-background transition", user[k] ? "left-[18px]" : "left-0.5")} />
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-10 max-w-xl border-t pt-6">
        <button onClick={() => { signOut(); toast("Signed out"); nav({ to: "/" }); }} className={btnGhost}>Sign out</button>
      </div>
    </AccountLayout>
  );
}
