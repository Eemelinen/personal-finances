"use server";

import { redirect } from "next/navigation";
import { LoginThrottle } from "@/server/auth/login-throttle";
import { verifyPassword } from "@/server/auth/password";
import { getAuthEnv } from "@/server/env";
import { createSession, deleteSession } from "./session";
import { LOGIN_PATH } from "./routes";

export type LoginState = { error?: string };

const throttle = new LoginThrottle();
// Attempts run one at a time, so parallel requests cannot all slip in before
// the throttle has counted the earlier failures.
let queue: Promise<unknown> = Promise.resolve();

async function checkPassword(password: string): Promise<LoginState> {
  const now = Date.now();
  const waitMs = throttle.retryAfterMs(now);
  if (waitMs > 0) {
    return {
      error: `Too many failed attempts. Try again in ${Math.ceil(waitMs / 1000)} s.`,
    };
  }
  if (await verifyPassword(getAuthEnv().AUTH_PASSWORD_HASH, password)) {
    throttle.recordSuccess();
    return {};
  }
  throttle.recordFailure(Date.now());
  console.warn(`[auth] failed login attempt (${throttle.failures} in a row)`);
  return { error: "Wrong password." };
}

export async function login(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0) {
    return { error: "Enter the password." };
  }

  const attempt = queue.then(() => checkPassword(password));
  queue = attempt.catch(() => undefined);
  const result = await attempt;
  if (result.error) return result;

  await createSession();
  redirect("/");
}

export async function logout(): Promise<void> {
  await deleteSession();
  redirect(LOGIN_PATH);
}
