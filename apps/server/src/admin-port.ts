/**
 * MAILFORGE_ADMIN_PORT: where the standalone admin console listens. Unset means the console
 * stays inside the customer app. A value that is not a usable port, or that equals the main
 * port, stops the server: guessing here would leave the console on the wrong surface.
 */
export function parseAdminPort(raw: string | undefined, mainPort: number): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const text = raw.trim();
  const n = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`MAILFORGE_ADMIN_PORT "${raw}" is not a valid port (1 to 65535).`);
  }
  if (n === mainPort) {
    throw new Error(`MAILFORGE_ADMIN_PORT (${n}) must differ from PORT (${mainPort}): the admin console is a separate surface.`);
  }
  return n;
}
