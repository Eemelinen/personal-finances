import type { Metadata } from "next";
import { Wallet } from "lucide-react";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Log in" };

// Outside the (app) route group: no shell, and the proxy lets it through
// without a session.
export default function LoginPage() {
  return (
    <main className="flex flex-1 items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col gap-6 rounded-xl border p-6 shadow-sm">
        <div className="flex flex-col items-center gap-2 text-center">
          <Wallet className="size-8" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight">
            Personal Finances
          </h1>
          <p className="text-muted-foreground text-sm">
            Enter your password to continue.
          </p>
        </div>
        <LoginForm />
      </div>
    </main>
  );
}
