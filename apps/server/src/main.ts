import Fastify from "fastify";

const VALID_ROLES = ["all", "api", "worker", "scheduler"] as const;
type Role = (typeof VALID_ROLES)[number];

function parseRole(): Role {
  const raw = process.argv.find((a) => a.startsWith("--role="))?.split("=")[1] ?? "all";
  if (!VALID_ROLES.includes(raw as Role)) {
    console.error(`Invalid role: ${raw}. Valid: ${VALID_ROLES.join(", ")}`);
    process.exit(1);
  }
  return raw as Role;
}

const role = parseRole();
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const app = Fastify({ logger: true });

// Health endpoint - always registered regardless of role
app.get("/health", async () => {
  return { status: "ok", role, edition: process.env.CLAROS_EDITION ?? "community" };
});

async function start() {
  try {
    await app.listen({ port, host });
    console.log(`Claros server started (role=${role}) on ${host}:${port}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();
