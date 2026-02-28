import { betterAuth } from "better-auth";
import { Pool } from "pg";

// Validate critical environment variables at startup
if (!process.env.DATABASE_URL) {
  throw new Error("[guardian-auth] DATABASE_URL is required");
}
if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error("[guardian-auth] BETTER_AUTH_SECRET is required");
}

const isDev = process.env.NODE_ENV !== "production";

const trustedOrigins = [
  process.env.BETTER_AUTH_URL,
  process.env.NEXT_PUBLIC_BASE_URL,
  // Localhost only in development
  ...(isDev ? ["http://localhost:3000", "http://127.0.0.1:3000"] : []),
].filter(Boolean) as string[];

export const auth = betterAuth({
  database: new Pool({
    connectionString: process.env.DATABASE_URL,
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  basePath: "/api/guardian-auth",
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
  },
  trustedOrigins,
  rateLimit: {
    enabled: true,
    window: 60,   // seconds
    max: 10,      // max attempts per window per IP
  },
  advanced: {
    // SameSite=None required to work in cross-origin iframes (Figma plugin).
    // Secure=true also works on localhost because Chrome treats it as a secure origin.
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
      httpOnly: true,
      path: "/",
    },
  },
});
