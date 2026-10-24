import type { Metadata } from "next";
import { ChartPie, ChevronRight, Tags } from "lucide-react";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { REPORT_SETTINGS_PATH } from "@/lib/reports";

export const metadata: Metadata = { title: "Settings" };

const SECTIONS = [
  {
    href: "/settings/categories",
    title: "Categories and rules",
    description:
      "Spending and income categories, and the rules that categorise transactions.",
    icon: Tags,
  },
  {
    href: REPORT_SETTINGS_PATH,
    title: "Reports",
    description: "What the cash-flow report and the dashboard count as income.",
    icon: ChartPie,
  },
] as const;

export default function SettingsPage() {
  return (
    <>
      <PageHeader
        title="Settings"
        description="Categories, rules and app preferences."
      />
      <ul className="flex flex-col gap-3">
        {SECTIONS.map(({ href, title, description, icon: Icon }) => (
          <li key={href}>
            <Link
              href={href}
              className="hover:bg-muted focus-visible:ring-ring/50 flex items-center gap-4 rounded-xl border p-4 outline-none focus-visible:ring-3"
            >
              <Icon
                className="text-muted-foreground size-5"
                aria-hidden="true"
              />
              <span className="flex flex-1 flex-col gap-1">
                <span className="font-medium">{title}</span>
                <span className="text-muted-foreground text-sm">
                  {description}
                </span>
              </span>
              <ChevronRight
                className="text-muted-foreground size-4"
                aria-hidden="true"
              />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
