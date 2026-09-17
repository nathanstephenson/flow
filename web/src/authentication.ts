/**
 * Begin a fresh top-level OIDC flow after a request was refused.
 *
 * The failed operation is never replayed. In particular, callers invoke this only after receiving
 * the response to a POST, so reauthentication cannot accidentally issue a command twice.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  beginReauthentication(response);
  return response;
}

export function beginReauthentication(response: Response): boolean {
  const login = response.headers.get("x-flow-login");
  if (response.status !== 401 || !login) return false;
  goToLogin(login);
  return true;
}

/** A WebSocket close has no response headers; code 4001 is the server's OIDC-revocation signal. */
export function reauthenticateClosedSocket(code: number): void {
  if (code === 4001) goToLogin("/oauth/login");
}

function goToLogin(login: string): void {
  const here = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const separator = login.includes("?") ? "&" : "?";
  window.location.assign(`${login}${separator}return_to=${encodeURIComponent(here)}`);
}
