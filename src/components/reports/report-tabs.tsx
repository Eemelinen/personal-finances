import Link from "next/link";
import { cn } from "cn";
import { CASH_FLOW_PATH, SPENDING_PATH } from "@/lib/reports";

const TABS = [
  { href: SPENDING_PATH, label: "Spending" },
  { href: CASH_FLOW_PATH, label: "Cash flow" },
] as const;

/** Switches between the two reports. */
export function ReportTabs({
  active,
}: {
  active: (typeof TABS)[number]["href"];
}) {
  return (
    <nav aria-label="Reports" className="mb-6 flex gap-1 border-b">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          aria-current={tab.href === active ? "page" : undefined}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
            tab.href === active
              ? "border-foreground text-foreground"
              : "text-muted-foreground hover:text-foreground border-transparent",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
