import { betterAuth } from "better-auth";
import { Pool } from "pg";

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  basePath: "/api/guardian-auth",
  emailAndPassword: {
    enabled: true,
  },
  trustedOrigins: [
    process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
  ],
  advanced: {
    // SameSite=None requis pour fonctionner dans les iframes cross-origin (Figma plugin).
    // Secure=true fonctionne aussi sur localhost car Chrome le traite comme origine sécurisée.
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
      httpOnly: true,
      path: "/",
    },
  },
});
