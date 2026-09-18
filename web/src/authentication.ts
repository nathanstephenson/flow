export async function authenticatedFetch(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, { credentials: "same-origin", ...init });
  beginReauthentication(response);
  return response;
}

let navigatingToLogin = false;

export function beginReauthentication(response: Response): boolean {
  const login = response.headers.get("x-flow-login");
  if (response.status !== 401 || !login) return false;
  navigateToLogin(login);
  return true;
}

export function reauthenticateClosedSocket(code: number): void {
  if (code === 4001) navigateToLogin("/oauth/login");
}

function navigateToLogin(login: string): void {
  if (navigatingToLogin) return;
  navigatingToLogin = true;
  const browser = globalThis as unknown as {
    location: { pathname: string; search: string; hash: string; assign(url: string): void };
  };
  const here = `${browser.location.pathname}${browser.location.search}${browser.location.hash}`;
  const separator = login.includes("?") ? "&" : "?";
  browser.location.assign(`${login}${separator}return_to=${encodeURIComponent(here)}`);
}
