export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
}

export interface WorkerEnv {
  ALLOW_INSECURE_AUTH?: string;
}

function readAuthToken(request: Request) {
  const header = request.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    return header.slice("Bearer ".length).trim();
  }

  const url = new URL(request.url);
  return url.searchParams.get("token")?.trim() || null;
}

function parseDevToken(token: string | null): AuthenticatedUser | null {
  if (!token) {
    return null;
  }

  if (token.startsWith("dev:")) {
    const [, rawId = "dev-user", rawName = "ViewerLeaf Dev"] = token.split(":");
    const id = rawId.trim() || "dev-user";
    const encodedName = rawName.trim() || "ViewerLeaf%20Dev";
    const name = decodeDevTokenName(encodedName);
    return {
      id,
      email: `${id}@viewerleaf.dev`,
      name,
      avatarUrl: "",
    };
  }

  return null;
}

function decodeDevTokenName(value: string) {
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, "%20")).trim();
    return decoded || "ViewerLeaf Dev";
  } catch {
    return value.trim() || "ViewerLeaf Dev";
  }
}

export async function verifyRequestAuth(request: Request, env: WorkerEnv): Promise<AuthenticatedUser> {
  const token = readAuthToken(request);
  const insecureAllowed = env.ALLOW_INSECURE_AUTH === "true";

  if (insecureAllowed && !token) {
    return {
      id: "dev-user",
      email: "dev-user@viewerleaf.dev",
      name: "ViewerLeaf Dev",
      avatarUrl: "",
    };
  }

  const devUser = parseDevToken(token);
  if (devUser) {
    return devUser;
  }

  throw new Response(
    JSON.stringify({
      error: "unauthorized",
      message: "Missing or invalid auth token.",
    }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
      },
    },
  );
}

export function corsHeaders(origin = "*") {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
  };
}
