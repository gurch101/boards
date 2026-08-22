export function generateAccessKey() {
  const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
export async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function normalizeSearch(...parts: unknown[]) {
  return parts.filter(value => value !== null && value !== undefined).map(value => String(value).normalize("NFKC").toLocaleLowerCase()).join(" \n").trim();
}
