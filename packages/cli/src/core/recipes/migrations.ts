/**
 * Static, recipe-owned migrations. They were generated once, at
 * recipe-authoring time, by the pinned drizzle-kit (0.31.11) from the
 * recipes' own schema templates — never at install time — so every plan
 * previews the exact SQL it adds. Data owns 0000, auth owns 0001; the
 * snapshots chain (0001.prevId = 0000.id) and the journal entries are exactly
 * what drizzle-kit wrote, so a later `bun run db:generate` diffs the user's
 * schema against them correctly (verified: it reports "No schema changes"
 * right after both are applied).
 *
 * To regenerate (after editing a schema template or bumping drizzle-kit):
 * materialize SCHEMA_TS in a scratch app with the pinned drizzle-orm and
 * drizzle-kit, run `drizzle-kit generate --name data_init`, append the
 * auth.schema region (AUTH_SCHEMA_TS + NOTES_SCHEMA_TS exports) and run
 * `drizzle-kit generate --name auth_init`, then copy the SQL, the snapshots
 * (minified), and the journal entries here byte-for-byte.
 */

export interface JournalEntry {
  readonly idx: number;
  readonly version: string;
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
}

export interface StaticMigration {
  readonly entry: JournalEntry;
  /** The migration SQL exactly as drizzle-kit wrote it. */
  readonly sql: string;
  /** drizzle-kit's schema snapshot after this migration (minified JSON). */
  readonly snapshot: string;
}

export const DATA_MIGRATION: StaticMigration = {
  entry: { idx: 0, version: "6", when: 1791457079688, tag: "0000_data_init", breakpoints: true },
  sql: "CREATE TABLE `todos` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL,\n\t`done` integer DEFAULT false NOT NULL,\n\t`created_at` integer NOT NULL\n);\n",
  snapshot:
    '{"version":"6","dialect":"sqlite","id":"bf848a4b-ad3b-49f0-b63b-26f305c41a4d","prevId":"00000000-0000-0000-0000-000000000000","tables":{"todos":{"name":"todos","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"title":{"name":"title","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"done":{"name":"done","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false,"default":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{},"foreignKeys":{},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}}},"views":{},"enums":{},"_meta":{"schemas":{},"tables":{},"columns":{}},"internal":{"indexes":{}}}',
};

export const AUTH_MIGRATION: StaticMigration = {
  entry: { idx: 1, version: "6", when: 1791457167617, tag: "0001_auth_init", breakpoints: true },
  sql: "CREATE TABLE `account` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`account_id` text NOT NULL,\n\t`provider_id` text NOT NULL,\n\t`user_id` text NOT NULL,\n\t`access_token` text,\n\t`refresh_token` text,\n\t`id_token` text,\n\t`access_token_expires_at` integer,\n\t`refresh_token_expires_at` integer,\n\t`scope` text,\n\t`password` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint\nCREATE TABLE `session` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`token` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL,\n\t`ip_address` text,\n\t`user_agent` text,\n\t`user_id` text NOT NULL,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint\nCREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint\nCREATE TABLE `user` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`name` text NOT NULL,\n\t`email` text NOT NULL,\n\t`email_verified` integer DEFAULT false NOT NULL,\n\t`image` text,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);\n--> statement-breakpoint\nCREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint\nCREATE TABLE `verification` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`identifier` text NOT NULL,\n\t`value` text NOT NULL,\n\t`expires_at` integer NOT NULL,\n\t`created_at` integer NOT NULL,\n\t`updated_at` integer NOT NULL\n);\n--> statement-breakpoint\nCREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint\nCREATE TABLE `notes` (\n\t`id` text PRIMARY KEY NOT NULL,\n\t`user_id` text NOT NULL,\n\t`body` text NOT NULL,\n\t`created_at` integer NOT NULL,\n\tFOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade\n);\n--> statement-breakpoint\nCREATE INDEX `notes_user_id_idx` ON `notes` (`user_id`);",
  snapshot:
    '{"version":"6","dialect":"sqlite","id":"148cee6c-a476-42fa-9ad2-6718312863d8","prevId":"bf848a4b-ad3b-49f0-b63b-26f305c41a4d","tables":{"todos":{"name":"todos","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"title":{"name":"title","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"done":{"name":"done","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false,"default":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{},"foreignKeys":{},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}},"account":{"name":"account","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"account_id":{"name":"account_id","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"provider_id":{"name":"provider_id","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"user_id":{"name":"user_id","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"access_token":{"name":"access_token","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"refresh_token":{"name":"refresh_token","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"id_token":{"name":"id_token","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"access_token_expires_at":{"name":"access_token_expires_at","type":"integer","primaryKey":false,"notNull":false,"autoincrement":false},"refresh_token_expires_at":{"name":"refresh_token_expires_at","type":"integer","primaryKey":false,"notNull":false,"autoincrement":false},"scope":{"name":"scope","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"password":{"name":"password","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"updated_at":{"name":"updated_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{"account_userId_idx":{"name":"account_userId_idx","columns":["user_id"],"isUnique":false}},"foreignKeys":{"account_user_id_user_id_fk":{"name":"account_user_id_user_id_fk","tableFrom":"account","tableTo":"user","columnsFrom":["user_id"],"columnsTo":["id"],"onDelete":"cascade","onUpdate":"no action"}},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}},"session":{"name":"session","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"expires_at":{"name":"expires_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"token":{"name":"token","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"updated_at":{"name":"updated_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"ip_address":{"name":"ip_address","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"user_agent":{"name":"user_agent","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"user_id":{"name":"user_id","type":"text","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{"session_token_unique":{"name":"session_token_unique","columns":["token"],"isUnique":true},"session_userId_idx":{"name":"session_userId_idx","columns":["user_id"],"isUnique":false}},"foreignKeys":{"session_user_id_user_id_fk":{"name":"session_user_id_user_id_fk","tableFrom":"session","tableTo":"user","columnsFrom":["user_id"],"columnsTo":["id"],"onDelete":"cascade","onUpdate":"no action"}},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}},"user":{"name":"user","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"name":{"name":"name","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"email":{"name":"email","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"email_verified":{"name":"email_verified","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false,"default":false},"image":{"name":"image","type":"text","primaryKey":false,"notNull":false,"autoincrement":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"updated_at":{"name":"updated_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{"user_email_unique":{"name":"user_email_unique","columns":["email"],"isUnique":true}},"foreignKeys":{},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}},"verification":{"name":"verification","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"identifier":{"name":"identifier","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"value":{"name":"value","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"expires_at":{"name":"expires_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false},"updated_at":{"name":"updated_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{"verification_identifier_idx":{"name":"verification_identifier_idx","columns":["identifier"],"isUnique":false}},"foreignKeys":{},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}},"notes":{"name":"notes","columns":{"id":{"name":"id","type":"text","primaryKey":true,"notNull":true,"autoincrement":false},"user_id":{"name":"user_id","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"body":{"name":"body","type":"text","primaryKey":false,"notNull":true,"autoincrement":false},"created_at":{"name":"created_at","type":"integer","primaryKey":false,"notNull":true,"autoincrement":false}},"indexes":{"notes_user_id_idx":{"name":"notes_user_id_idx","columns":["user_id"],"isUnique":false}},"foreignKeys":{"notes_user_id_user_id_fk":{"name":"notes_user_id_user_id_fk","tableFrom":"notes","tableTo":"user","columnsFrom":["user_id"],"columnsTo":["id"],"onDelete":"cascade","onUpdate":"no action"}},"compositePrimaryKeys":{},"uniqueConstraints":{},"checkConstraints":{}}},"views":{},"enums":{},"_meta":{"schemas":{},"tables":{},"columns":{}},"internal":{"indexes":{}}}',
};

const JOURNAL_FORMAT = { version: "7", dialect: "sqlite" } as const;

/** drizzle-kit writes its JSON with two-space indentation and no trailing newline. */
function kitJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** meta/_journal.json holding exactly these entries. */
export function journalFile(entries: readonly JournalEntry[]): string {
  return kitJson({ ...JOURNAL_FORMAT, entries });
}

/** meta/<idx>_snapshot.json content. */
export function snapshotFile(migration: StaticMigration): string {
  return kitJson(JSON.parse(migration.snapshot));
}

/** File names inside the app's drizzle/ folder, from a journal entry (drizzle-kit's naming). */
export function sqlFileName(entry: Pick<JournalEntry, "tag">): string {
  return `${entry.tag}.sql`;
}

export function snapshotFileName(entry: Pick<JournalEntry, "idx">): string {
  return `meta/${String(entry.idx).padStart(4, "0")}_snapshot.json`;
}
