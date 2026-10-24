import type { Metadata } from "next";
import { Suspense } from "react";
import { PageHeader } from "@/components/page-header";
import { verifySession } from "@/lib/auth/session";
import { listCategoryUsage, listRules } from "@/server/categorization/manage";
import { CategoriesManager } from "./categories-manager";

export const metadata: Metadata = { title: "Categories and rules" };

export default function CategoriesPage() {
  return (
    <>
      <PageHeader
        title="Categories and rules"
        description="Rules run from the top; the first one that matches a transaction gives its category. Rules never change a category you set by hand."
      />
      <Suspense
        fallback={<p className="text-muted-foreground">Loading categories…</p>}
      >
        <CategoriesSection />
      </Suspense>
    </>
  );
}

async function CategoriesSection() {
  await verifySession();
  const [categories, rules] = await Promise.all([
    listCategoryUsage(),
    listRules(),
  ]);
  return <CategoriesManager categories={categories} rules={rules} />;
}
