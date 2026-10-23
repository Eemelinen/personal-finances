"use server";

import { redirect } from "next/navigation";
import { createLoginChecker } from "@/server/auth/login";
import { verifyPassword } from "@/server/auth/password";
import { getAuthEnv } from "@/server/env";
import { createSession, deleteSession } from "./session";
import { LOGIN_PATH } from "./routes";

export type LoginState = { error?: string };

// One checker (and so one backoff counter) per server process.
const checkLogin = createLoginChecker({
  verify: (password) =>
    verifyPassword(getAuthEnv().AUTH_PASSWORD_HASH, password),
  onFailure: (failures) => {
    console.warn(`[auth] failed login attempt (${failures} in a row)`);
  },
});

export async function login(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const password = formData.get("password");
  if (typeof password !== "string" || password.length === 0) {
    return { error: "Enter the password." };
  }

  const result = await checkLogin(password);
  if (!result.ok) return { error: result.error };

  await createSession();
  redirect("/");
}

export async function logout(): Promise<void> {
  await deleteSession();
  redirect(LOGIN_PATH);
}
