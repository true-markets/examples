import { Hono } from "hono";
import { z } from "zod";
import { findByEmail, verifyPassword, type Advisor } from "../advisors.ts";
import { ApiError, parseJson } from "../http.ts";
import { clearSession, requireAdvisor, setSession, type AppEnv } from "../session.ts";

const loginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });

function profile(advisor: Advisor) {
  return { email: advisor.email, name: advisor.name };
}

export function authRoutes() {
  return new Hono<AppEnv>()
    .post("/login", async (c) => {
      const { email, password } = await parseJson(c, loginBody);
      const advisor = findByEmail(email);
      if (!advisor || !(await verifyPassword(advisor, password))) {
        throw new ApiError(401, "unauthenticated", "Email or password is incorrect.");
      }
      await setSession(c, advisor.id);
      return c.json(profile(advisor));
    })
    .post("/logout", requireAdvisor, (c) => {
      clearSession(c);
      return c.body(null, 204);
    })
    .get("/me", requireAdvisor, (c) => c.json(profile(c.var.advisor)));
}
