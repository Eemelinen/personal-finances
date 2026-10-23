/**
 * Test-only login credentials for L3. They exist only in the throwaway
 * server tests/e2e/support/server.ts starts; never reuse them anywhere real.
 */
export const E2E_PASSWORD = "e2e-test-password";
export const E2E_SESSION_SECRET =
  "e2e-only-session-secret-not-for-real-use-0001";

/** Playwright storage state of a logged-in browser (written by auth.setup.ts). */
export const E2E_AUTH_STATE = "test-results/.auth/session.json";
