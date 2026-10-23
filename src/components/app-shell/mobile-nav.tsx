"use client";

import { Suspense, useState } from "react";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ActiveNavList, NavList } from "./nav-list";

/** Below the `md` breakpoint the sidebar is hidden; this menu replaces it. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="md:hidden">
          <Menu />
          <span className="sr-only">Open menu</span>
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="bg-sidebar w-72">
        <SheetHeader>
          <SheetTitle>Personal Finances</SheetTitle>
          <SheetDescription className="sr-only">
            Main navigation
          </SheetDescription>
        </SheetHeader>
        <nav aria-label="Main" className="px-3">
          <Suspense fallback={<NavList onNavigate={close} />}>
            <ActiveNavList onNavigate={close} />
          </Suspense>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
