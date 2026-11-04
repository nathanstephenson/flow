export function sandboxUnavailable(): Error {
  return new Error("Sandbox isolation is unavailable; unrestricted launch refused: no sandbox provider is configured");
}
