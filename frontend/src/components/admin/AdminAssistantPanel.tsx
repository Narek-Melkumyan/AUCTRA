import { useQuery } from "@tanstack/react-query";
import { AssistantChat } from "@/components/ai/AssistantChat";
import { aiApi } from "@/lib/api/ai";
import { Section } from "./shared";

/** Admin-only AI assistant (read-only tools; suggests, never executes, sensitive actions). */
export function AdminAssistantPanel() {
  const usage = useQuery({ queryKey: ["ai", "usage"], queryFn: () => aiApi.usage(30) });
  const total = usage.data?.byScope.reduce((a, s) => a + s.totalTokens, 0) ?? 0;
  const requests = usage.data?.byScope.reduce((a, s) => a + s.requests, 0) ?? 0;
  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_320px]">
      <div className="h-[680px] overflow-hidden rounded-2xl border bg-card">
        <AssistantChat scope="admin" />
      </div>
      <Section title="AI usage (30 days)" description="Token accounting for spend control.">
        {usage.data ? (
          <dl className="space-y-3 p-5 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Provider</dt>
              <dd>{usage.data.configured ? `OpenAI · ${usage.data.model}` : "Not configured"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Requests</dt>
              <dd className="tabular">{requests.toLocaleString()}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tokens</dt>
              <dd className="tabular">{total.toLocaleString()}</dd>
            </div>
            {usage.data.byScope.map((s) => (
              <div key={s.scope} className="flex justify-between text-xs">
                <dt className="text-muted-foreground">{s.scope.toLowerCase()} assistant</dt>
                <dd className="tabular">
                  {s.requests} req · {s.totalTokens.toLocaleString()} tok
                </dd>
              </div>
            ))}
            <div className="border-t pt-3 text-xs text-muted-foreground">
              Daily limits: {usage.data.limits.userDaily.toLocaleString()} per member ·{" "}
              {usage.data.limits.adminDaily.toLocaleString()} per admin ·{" "}
              {usage.data.limits.globalDaily.toLocaleString()} platform-wide (tokens).
            </div>
          </dl>
        ) : (
          <p className="p-5 text-sm text-muted-foreground">Loading usage…</p>
        )}
      </Section>
    </div>
  );
}
