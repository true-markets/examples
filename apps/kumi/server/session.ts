import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { findById, type Advisor } from "./advisors.ts";
import { ApiError } from "./http.ts";
import { persistentSecret } from "./secrets.ts";

const COOKIE = "kumi_session";
const COOKIE_OPTIONS = { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 7 * 24 * 60 * 60 } as const;

const SESSION_SECRET = persistentSecret("session-secret", () => randomBytes(32).toString("hex")).value;

export interface AppEnv {
  Variables: { advisor: Advisor };
}

export function setSession(c: Context, advisorId: string): Promise<void> {
  return setSignedCookie(c, COOKIE, advisorId, SESSION_SECRET, COOKIE_OPTIONS);
}

export function clearSession(c: Context): void {
  deleteCookie(c, COOKIE, { path: "/" });
}

export const requireAdvisor = createMiddleware<AppEnv>(async (c, next) => {
  const id = await getSignedCookie(c, SESSION_SECRET, COOKIE);
  const advisor = id ? findById(id) : undefined;
  if (!advisor) throw new ApiError(401, "unauthenticated", "sign in");
  c.set("advisor", advisor);
  await next();
});
