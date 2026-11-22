import { Fragment, type ReactNode } from "react";
import { useRouter } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

/**
 * Minimal, XSS-safe Markdown: paragraphs, bullet/numbered lists, **bold**, `code`,
 * and links to in-app paths only. Everything is rendered as React text nodes.
 */
export function SafeMarkdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag
        key={blocks.length}
        className={cn("space-y-0.5 pl-5", list.ordered ? "list-decimal" : "list-disc")}
      >
        {list.items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = !!numbered;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={blocks.length} className="pt-1 font-semibold">
          {inline(heading[1]!)}
        </p>
      ) : (
        <p key={blocks.length} className="whitespace-pre-wrap break-words">
          {inline(line)}
        </p>
      ),
    );
  }
  flush();
  return <>{blocks}</>;
}

function inline(s: string): ReactNode {
  const out: ReactNode[] = [];
  const re =
    /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|(?<![\w/])\/(?:room|item)\/[0-9a-f-]{36})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={out.length}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`"))
      out.push(
        <code key={out.length} className="rounded bg-muted px-1 text-[0.85em]">
          {tok.slice(1, -1)}
        </code>,
      );
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
      const label = link ? link[1]! : tok;
      const href = link ? link[2]! : tok;
      out.push(<SafeLink key={out.length} href={href} label={label} />);
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

/** Only relative in-app links become anchors; anything else is shown as plain text. */
function SafeLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  if (!/^\/[A-Za-z0-9/_\-?=&.%]*$/.test(href)) return <>{label}</>;
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        void router.navigate({ to: href as "/" });
      }}
      className="font-medium underline underline-offset-2"
    >
      {label}
    </a>
  );
}
