import { AppShell } from "@/components/app-shell/app-shell";

// Every page of the app sits in this route group and shares the shell.
// Pages that must not show it (e.g. a login page) live outside the group.
export default function AppLayout({ children }: LayoutProps<"/">) {
  return <AppShell>{children}</AppShell>;
}
