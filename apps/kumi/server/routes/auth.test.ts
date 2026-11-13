import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { useTempDataDir } from "../testing.ts";

useTempDataDir("kumi-auth-");

let app: Hono;

beforeEach(async () => {
  const { authRoutes } = await import("./auth.ts");
  const { errorResponse } = await import("../http.ts");
  (await import("../advisors.ts")).ensureDemoAdvisor();
  app = new Hono().route("/api", authRoutes());
  app.onError(errorResponse);
});

function login(email: string, password: string) {
  return app.request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
}

function sessionCookie(res: Response): string {
  return (res.headers.get("Set-Cookie") ?? "").split(";")[0]!;
}

describe("auth routes", () => {
  it("signs the demo advisor in and sets the session cookie", async () => {
    const res = await login("Hana.Sato@kumi.example", "kumi-demo");

    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toMatch(/^kumi_session=.+HttpOnly/);
    expect(await res.json()).toEqual({ email: "hana.sato@kumi.example", name: "Hana Sato" });
  });

  it("rejects a wrong password without a cookie", async () => {
    const res = await login("hana.sato@kumi.example", "not-the-password");

    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.json()).toEqual({ type: "unauthenticated", message: "Email or password is incorrect." });
  });

  it("rejects an unknown email the same way", async () => {
    const res = await login("someone@kumi.example", "kumi-demo");

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: "Email or password is incorrect." });
  });

  it("answers /me with the advisor behind the cookie", async () => {
    const cookie = sessionCookie(await login("hana.sato@kumi.example", "kumi-demo"));

    const res = await app.request("/api/me", { headers: { Cookie: cookie } });

    expect(await res.json()).toEqual({ email: "hana.sato@kumi.example", name: "Hana Sato" });
  });

  it("clears the session cookie on logout", async () => {
    const cookie = sessionCookie(await login("hana.sato@kumi.example", "kumi-demo"));

    const res = await app.request("/api/logout", { method: "POST", headers: { Cookie: cookie } });

    expect(res.status).toBe(204);
    expect(res.headers.get("Set-Cookie")).toMatch(/^kumi_session=;.*Max-Age=0/);
  });
});
