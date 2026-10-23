import type { LucideIcon } from "lucide-react";

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Optional call to action, e.g. a link button. */
  children?: React.ReactNode;
}

/** Shown where a page has no data (or no feature) yet. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: EmptyStateProps) {
  return (
    <section
      data-testid="empty-state"
      className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center"
    >
      <div className="bg-muted flex size-12 items-center justify-center rounded-full">
        <Icon className="text-muted-foreground size-6" aria-hidden="true" />
      </div>
      <h2 className="text-lg font-medium">{title}</h2>
      <p className="text-muted-foreground max-w-sm text-sm">{description}</p>
      {children}
    </section>
  );
}
