/**
 * File templates for auth.better-auth, taken from the certified 2026-10-07
 * prototype (Hono + Better Auth 1.7.7 email/password on the Drizzle adapter).
 * All modules live next to the app's server entry and import each other
 * relatively, so the same bytes work for every layout.
 *
 * AUTH_SCHEMA_TS is verbatim output of the pinned Better Auth CLI for AUTH_TS
 * (`bunx --bun auth@1.7.7 generate`), so `bun run auth:generate` reproduces it
 * byte-for-byte; together with NOTES_SCHEMA_TS it is the source the static
 * migration 0001 was generated from (../migrations.ts) — change them together.
 */

export const AUTH_TS = `/**
 * Better Auth server instance (Groot recipe auth.better-auth): email +
 * password accounts and cookie sessions stored through the app's Drizzle
 * client. BETTER_AUTH_SECRET signs sessions and BETTER_AUTH_URL is this API's
 * public origin; both are read from the environment (.env.local in development).
 *
 * After changing this config, refresh the tables: \`bun run auth:generate\`
 * (rewrites db/auth-schema.ts), then \`bun run db:generate\`.
 */
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth/minimal";
import { db } from "./db/client";
import * as schema from "./db/schema";

/**
 * Header the auth routes overwrite with the socket's remote address (see
 * http/auth-routes.ts); Better Auth keys its rate limits by it. Behind a
 * reverse proxy, switch to the proxy's header (e.g. "x-forwarded-for") plus
 * \`trustedProxies\`.
 */
export const CLIENT_IP_HEADER = "x-client-ip";

/** Browser origins (e.g. a web app) allowed to call this API with cookies: BETTER_AUTH_TRUSTED_ORIGINS, comma-separated. */
export const trustedOrigins = (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true },
  trustedOrigins,
  advanced: {
    ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
  },
});

export type AuthSession = typeof auth.$Infer.Session;
`;

export const AUTH_SCHEMA_TS = `import { relations } from "drizzle-orm";
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .default(false)
    .notNull(),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .$onUpdate(() => new Date())
    .notNull(),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp_ms",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
`;

export const NOTES_SCHEMA_TS = `/**
 * The reference protected resource (Groot recipe auth.better-auth): every
 * note belongs to exactly one Better Auth user and is deleted with them.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";

export const notes = sqliteTable(
  "notes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("notes_user_id_idx").on(table.userId)],
);

export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
`;

/** Body of the auth.schema region Groot adds to the (human-owned) schema barrel. */
export const SCHEMA_REGION = `export * from "./auth-schema";
export * from "./notes-schema";`;

export const CORS_TS = `import { cors } from "hono/cors";
import { trustedOrigins } from "../auth";

/** Credentialed CORS for the browser origins Better Auth also trusts (BETTER_AUTH_TRUSTED_ORIGINS). */
export const trustedCors = () =>
  cors({ origin: trustedOrigins, credentials: true, allowMethods: ["GET", "POST", "DELETE", "OPTIONS"] });
`;

export const SESSION_TS = `import { createMiddleware } from "hono/factory";
import { auth, type AuthSession } from "../auth";

export type AuthedEnv = {
  Variables: {
    user: AuthSession["user"];
    session: AuthSession["session"];
  };
};

/** Rejects the request with 401 unless Better Auth resolves a live session from its cookie. */
export const requireSession = createMiddleware<AuthedEnv>(async (c, next) => {
  const { headers, response } = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  // Forward Better Auth's Set-Cookie (sliding-expiry refresh, or clearing a dead
  // cookie); otherwise the browser keeps its sign-in Max-Age while the session moves on.
  for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
  if (!response) return c.json({ error: "unauthorized" }, 401);
  c.set("user", response.user);
  c.set("session", response.session);
  await next();
});
`;

export const AUTH_ROUTES_TS = `import { Hono } from "hono";
import { auth, CLIENT_IP_HEADER } from "../auth";
import { trustedCors } from "./cors";

/** Bun passes its Server as the 2nd fetch argument, which Hono exposes as \`c.env\`. */
type BunBindings = {
  requestIP?: (request: Request) => { address: string } | null;
};

/**
 * Better Auth's HTTP surface (Groot recipe auth.better-auth). Mounted at the
 * auth basePath, "/api/auth": \`app.route("/api/auth", authRoutes)\`.
 */
export const authRoutes = new Hono<{ Bindings: BunBindings }>().use("*", trustedCors()).all("/*", (c) => {
  // Overwrite (never trust) the client-IP header so Better Auth rate-limits per client.
  const headers = new Headers(c.req.raw.headers);
  const address = c.env?.requestIP?.(c.req.raw)?.address;
  if (address) headers.set(CLIENT_IP_HEADER, address);
  else headers.delete(CLIENT_IP_HEADER);
  return auth.handler(new Request(c.req.raw, { headers }));
});
`;

export const NOTES_ROUTES_TS = `import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { db } from "../db/client";
import { notes } from "../db/notes-schema";
import { trustedCors } from "./cors";
import { type AuthedEnv, requireSession } from "./session";

const MAX_NOTE_LENGTH = 2_000;

/** Reference protected resource (Groot recipe auth.better-auth): every query is scoped to the session user. */
export const notesRoutes = new Hono<AuthedEnv>()
  .use("*", trustedCors())
  .use("*", requireSession)
  .get("/", async (c) => {
    const rows = await db
      .select()
      .from(notes)
      .where(eq(notes.userId, c.get("user").id))
      .orderBy(desc(notes.createdAt));
    return c.json({ notes: rows });
  })
  .post(
    "/",
    validator("json", (value, c) => {
      const body = (value as { body?: unknown } | null)?.body;
      if (typeof body !== "string" || body.trim().length === 0 || body.length > MAX_NOTE_LENGTH) {
        return c.json({ error: \`body must be a non-empty string of at most \${MAX_NOTE_LENGTH} chars\` }, 400);
      }
      return { body: body.trim() };
    }),
    async (c) => {
      const { body } = c.req.valid("json");
      const [note] = await db.insert(notes).values({ userId: c.get("user").id, body }).returning();
      return c.json({ note }, 201);
    },
  )
  .delete("/:id", async (c) => {
    // Ownership is part of the WHERE clause: another user's note is indistinguishable from a missing one.
    const deleted = await db
      .delete(notes)
      .where(and(eq(notes.id, c.req.param("id")), eq(notes.userId, c.get("user").id)))
      .returning({ id: notes.id });
    if (deleted.length === 0) return c.json({ error: "not_found" }, 404);
    return c.body(null, 204);
  });
`;
