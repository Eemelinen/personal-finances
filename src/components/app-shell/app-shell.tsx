import { Suspense } from "react";
import Link from "next/link";
import { Wallet } from "lucide-react";
import { LastSync } from "./last-sync";
import { LogoutButton } from "./logout-button";
import { MobileNav } from "./mobile-nav";
import { ActiveNavList, NavList } from "./nav-list";

/**
 * Header plus main navigation shared by every page: a sidebar from the `md`
 * breakpoint up, a menu button that opens a sheet below it.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 flex-col">
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-40 flex h-14 items-center gap-2 border-b px-4 backdrop-blur">
        <MobileNav />
        <Link
          href="/"
          className="focus-visible:ring-ring/50 flex items-center gap-2 rounded-lg font-semibold tracking-tight outline-none focus-visible:ring-3"
        >
          <Wallet className="size-5" aria-hidden="true" />
          Personal Finances
        </Link>
        <div className="ml-auto flex items-center gap-3">
          <Suspense fallback={null}>
            <LastSync />
          </Suspense>
          <Suspense fallback={null}>
            <LogoutButton />
          </Suspense>
        </div>
      </header>
      <div className="flex flex-1">
        <aside className="bg-sidebar hidden w-56 shrink-0 border-r p-3 md:block">
          <nav aria-label="Main" className="sticky top-17">
            <Suspense fallback={<NavList />}>
              <ActiveNavList />
            </Suspense>
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
