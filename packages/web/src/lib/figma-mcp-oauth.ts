import type { OAuthClientProvider, OAuthClientInformation, OAuthTokens } from "@ai-sdk/mcp";
import type { ReadonlyRequestCookies } from "next/dist/server/web/spec-extension/adapters/request-cookies";
import { getBaseUrl } from "./get-base-url";

export { getBaseUrl } from "./get-base-url";

// For OAuth discovery (without /mcp)
const MCP_FIGMA_OAUTH_URL = "https://mcp.figma.com";
// For MCP connection (with /mcp)
const MCP_FIGMA_SERVER_URL = "https://mcp.figma.com/mcp";

const COOKIE_TOKENS = "figma_mcp_tokens";
const COOKIE_CLIENT_INFO = "figma_mcp_client_info";
const COOKIE_CODE_VERIFIER = "figma_mcp_code_verifier";
const COOKIE_STATE = "figma_mcp_state";
const COOKIE_AUTH_TOKEN = "mcp_auth_token";

export async function getRedirectUrl(): Promise<string> {
  return `${await getBaseUrl()}/api/auth/figma-mcp/callback`;
}

export async function createFigmaMcpOAuthProvider(
  cookieStore: ReadonlyRequestCookies,
  setCookies?: (name: string, value: string, options: Record<string, unknown>) => void,
  forceState?: string,
): Promise<OAuthClientProvider> {
  const baseUrl = await getBaseUrl();
  const isSecure = baseUrl.startsWith("https");
  const redirectUrl = `${baseUrl}/api/auth/figma-mcp/callback`;

  const cookieOptions = {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
  };

  return {
    get redirectUrl() {
      return redirectUrl;
    },

    get clientMetadata() {
      return {
        client_name: "DS AI Guardian",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      };
    },

    async tokens(): Promise<OAuthTokens | undefined> {
      const raw = cookieStore.get(COOKIE_TOKENS)?.value;
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as OAuthTokens;
      } catch {
        return undefined;
      }
    },

    async saveTokens(tokens: OAuthTokens): Promise<void> {
      setCookies?.(COOKIE_TOKENS, JSON.stringify(tokens), {
        ...cookieOptions,
        maxAge: 7776000,
      });
    },

    async clientInformation(): Promise<OAuthClientInformation | undefined> {
      const raw = cookieStore.get(COOKIE_CLIENT_INFO)?.value;
      if (raw) {
        try {
          return JSON.parse(raw) as OAuthClientInformation;
        } catch {
          // ignore
        }
      }

      if (process.env.FIGMA_CLIENT_ID) {
        return {
          client_id: process.env.FIGMA_CLIENT_ID,
          client_secret: process.env.FIGMA_CLIENT_SECRET,
        };
      }
      return undefined;
    },

    async saveClientInformation(info: OAuthClientInformation): Promise<void> {
      setCookies?.(COOKIE_CLIENT_INFO, JSON.stringify(info), {
        ...cookieOptions,
        maxAge: 365 * 24 * 3600,
      });
    },

    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      throw new RedirectError(authorizationUrl.toString());
    },

    async saveCodeVerifier(codeVerifier: string): Promise<void> {
      setCookies?.(COOKIE_CODE_VERIFIER, codeVerifier, {
        ...cookieOptions,
        maxAge: 600,
      });
    },

    async codeVerifier(): Promise<string> {
      return cookieStore.get(COOKIE_CODE_VERIFIER)?.value || "";
    },

    async state(): Promise<string> {
      if (forceState) return forceState;
      const raw = cookieStore.get(COOKIE_STATE)?.value;
      return raw || "";
    },

    async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
      const sUrl = serverUrl.toString();
      const rUrl = resource || sUrl;
      if (sUrl.includes("figma.com") || rUrl.includes("figma.com")) {
        return new URL(rUrl);
      }
      return undefined;
    },
  };
}

export class RedirectError extends Error {
  public url: string;
  constructor(url: string) {
    super(`Redirect to ${url}`);
    this.url = url;
    this.name = "RedirectError";
  }
}

export function hasValidMcpTokens(cookieStore: ReadonlyRequestCookies): boolean {
  return !!cookieStore.get(COOKIE_TOKENS)?.value;
}

export { MCP_FIGMA_OAUTH_URL, MCP_FIGMA_SERVER_URL, COOKIE_TOKENS, COOKIE_CLIENT_INFO, COOKIE_CODE_VERIFIER, COOKIE_STATE, COOKIE_AUTH_TOKEN };
