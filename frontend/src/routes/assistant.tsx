import { createFileRoute } from "@tanstack/react-router";
import { AiChat } from "@/components/ai/AiChat";
import { AssistantChat } from "@/components/ai/AssistantChat";
import { IS_API_MODE } from "@/lib/auction-store";
import { metaFor } from "@/components/account/AccountLayout";

export const Route = createFileRoute("/assistant")({
  head: () => ({
    meta: metaFor(
      "AUCTRA assistant",
      "Ask about lots, fees and how bidding works. Informational only — it never bids for you.",
    ),
  }),
  component: () => (
    <div className="mx-auto flex h-[calc(100vh-9rem)] max-w-3xl flex-col px-4 py-6 sm:px-6">
      <div className="mb-4 border-b pb-4">
        <h1 className="text-2xl font-medium tracking-tight">Assistant</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Find lots, compare listings and understand bidding and the demo checkout.
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-lg border bg-card">
        {IS_API_MODE ? <AssistantChat /> : <AiChat />}
      </div>
    </div>
  ),
});
