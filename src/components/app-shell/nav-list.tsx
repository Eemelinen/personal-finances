"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { isActiveHref, NAV_ITEMS } from "@/lib/navigation";

interface NavListProps {
  /** The current pathname; without it no link is marked active. */
  pathname?: string;
  /** Called after a link is clicked (the mobile menu closes itself). */
  onNavigate?: () => void;
}

export function NavList({ pathname, onNavigate }: NavListProps) {
  return (
    <ul className="flex flex-col gap-1">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = pathname !== undefined && isActiveHref(pathname, href);
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-ring/50 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-3",
                active && "bg-sidebar-accent text-sidebar-accent-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * NavList with the active link taken from the URL. `usePathname` suspends
 * during prerendering on routes with unknown dynamic params (Cache
 * Components), so callers wrap this in `<Suspense>` with a plain `NavList`
 * as the fallback.
 */
export function ActiveNavList({
  onNavigate,
}: Pick<NavListProps, "onNavigate">) {
  return <NavList pathname={usePathname()} onNavigate={onNavigate} />;
}
