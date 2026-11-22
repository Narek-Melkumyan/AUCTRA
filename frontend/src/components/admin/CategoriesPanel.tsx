import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { input } from "@/components/account/AccountLayout";
import { adminApi, type AdminCategory, type AdminCategoryNode } from "@/lib/api/admin";
import { EmptyRow, ErrorState, Loading, Section, btnSm, select, useAdminAction } from "./shared";

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/** Category tree management (category:manage). Changes appear in the public catalogue. */
export function CategoriesPanel() {
  const q = useQuery({ queryKey: ["admin", "categories"], queryFn: adminApi.categories });
  const inv = [["admin", "categories"], ["categories"]];
  const update = useAdminAction(
    (a: { slug: string; patch: Parameters<typeof adminApi.updateCategory>[1] }) =>
      adminApi.updateCategory(a.slug, a.patch),
    { success: "Category updated", invalidate: inv },
  );
  const create = useAdminAction(adminApi.createCategory, {
    success: "Category created",
    invalidate: inv,
  });
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [editing, setEditing] = useState<{ slug: string; name: string } | null>(null);

  const row = (c: AdminCategory, sub = false) => (
    <li
      key={c.id}
      className={`flex flex-wrap items-center gap-3 py-3 pr-5 text-sm ${sub ? "pl-10" : "pl-5"}`}
    >
      <div className="min-w-0 flex-1">
        {editing?.slug === c.slug ? (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate({ slug: c.slug, patch: { name: editing.name.trim() } });
              setEditing(null);
            }}
          >
            <input
              aria-label={`New name for ${c.name}`}
              className={`${input} h-8`}
              value={editing.name}
              onChange={(e) => setEditing({ slug: c.slug, name: e.target.value })}
              autoFocus
            />
            <button className={btnSm} disabled={editing.name.trim().length < 2}>
              Save
            </button>
            <button type="button" className={btnSm} onClick={() => setEditing(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <>
            <p className={`font-medium ${c.isActive ? "" : "text-muted-foreground line-through"}`}>
              {c.name}
            </p>
            <p className="text-xs text-muted-foreground">
              {c.slug} · {c.auctionCount} listing{c.auctionCount === 1 ? "" : "s"} ·{" "}
              {c.openAuctionCount} open{c.isActive ? "" : " · hidden from sellers and buyers"}
            </p>
          </>
        )}
      </div>
      {editing?.slug !== c.slug && (
        <>
          <button className={btnSm} onClick={() => setEditing({ slug: c.slug, name: c.name })}>
            Rename
          </button>
          <button
            className={btnSm}
            disabled={update.isPending || (c.isActive && c.openAuctionCount > 0)}
            title={
              c.isActive && c.openAuctionCount > 0 ? "Open listings use this category" : undefined
            }
            onClick={() => update.mutate({ slug: c.slug, patch: { isActive: !c.isActive } })}
          >
            {c.isActive ? "Hide" : "Show"}
          </button>
        </>
      )}
    </li>
  );

  return (
    <div className="space-y-6">
      <Section
        title="Add a category"
        description="New categories appear immediately in the seller workspace and the public catalogue."
      >
        <form
          className="flex flex-wrap items-end gap-3 px-5 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            create.mutate(
              {
                name: n,
                slug: parent ? slugify(`${parent} ${n}`) : slugify(n),
                ...(parent ? { parentSlug: parent } : {}),
              },
              { onSuccess: () => setName("") },
            );
          }}
        >
          <label className="text-sm">
            Name
            <input
              className={`${input} mt-1 h-9 w-64`}
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-sm">
            Parent
            <select
              className={`${select} mt-1 block`}
              value={parent}
              onChange={(e) => setParent(e.target.value)}
            >
              <option value="">Top-level category</option>
              {(q.data ?? []).map((c: AdminCategoryNode) => (
                <option key={c.slug} value={c.slug}>
                  Subcategory of {c.name}
                </option>
              ))}
            </select>
          </label>
          <button className={btnSm} disabled={name.trim().length < 2 || create.isPending}>
            Add category
          </button>
          {name.trim().length >= 2 && (
            <span className="text-xs text-muted-foreground">
              slug: {parent ? slugify(`${parent} ${name}`) : slugify(name)}
            </span>
          )}
        </form>
      </Section>

      <Section
        title="Catalogue"
        description="Hidden categories cannot be chosen for new listings; existing listings keep them. A category with open listings cannot be hidden."
      >
        {q.isPending ? (
          <Loading rows={4} />
        ) : q.isError ? (
          <ErrorState error={q.error} retry={() => void q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyRow>No categories.</EmptyRow>
        ) : (
          <ul className="divide-y">
            {q.data.map((c) => [row(c), ...c.subcategories.map((s) => row(s, true))])}
          </ul>
        )}
      </Section>
    </div>
  );
}
