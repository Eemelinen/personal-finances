import {
  ArrowLeftRight,
  ChartPie,
  LayoutDashboard,
  Landmark,
  Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** The app shell's main navigation, in display order. */
export const NAV_ITEMS: readonly NavItem[] = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/transactions", label: "Transactions", icon: ArrowLeftRight },
  { href: "/reports", label: "Reports", icon: ChartPie },
  { href: "/connections", label: "Connections", icon: Landmark },
  { href: "/settings", label: "Settings", icon: Settings },
];

/**
 * Whether `href` is the current section: an exact match, or a page below it
 * (`/transactions/123` keeps Transactions active). The dashboard (`/`) only
 * matches itself, otherwise it would be active everywhere.
 */
export function isActiveHref(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
