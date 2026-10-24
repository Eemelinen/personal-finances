import * as React from "react";
import { cn } from "cn";

// Native form controls styled like the shadcn `Input`: a `<select>` and a
// `<textarea>` (native, so they work without JavaScript and in e2e tests).

const controlClass =
  "border-input focus-visible:border-ring focus-visible:ring-ring/50 dark:bg-input/30 disabled:cursor-not-allowed disabled:opacity-50 w-full min-w-0 rounded-lg border bg-transparent text-base outline-none focus-visible:ring-3 md:text-sm";

export function NativeSelect({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select className={cn(controlClass, "h-8 px-2", className)} {...props} />
  );
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return (
    <textarea
      className={cn(controlClass, "min-h-20 px-2.5 py-1.5", className)}
      {...props}
    />
  );
}
