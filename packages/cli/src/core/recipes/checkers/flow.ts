/**
 * The auth product flow, driven over real HTTP against the running app with a
 * manual cookie jar — adapted from the certified 2026-10-07 prototype flow
 * (24/24 steps passed there), plus the owner's own delete, which the
 * prototype never exercised.
 *
 * Every step records {step, request, expected, actual, ok, ms}. Expectations
 * are exact statuses plus semantic checks (the session belongs to the user who
 * signed up, a note is visible only to its owner, …). Session tokens are
 * collected so every artifact can be redacted; notes never contain them.
 */

export interface FlowStep {
  readonly step: string;
  readonly request: string;
  readonly expected: string;
  readonly actual: number;
  readonly ok: boolean;
  readonly ms: number;
}

export interface FlowRun {
  readonly steps: readonly FlowStep[];
  /** Per-step observations for the flow.json artifact (statuses, counts, ids — never tokens). */
  readonly notes: Readonly<Record<string, string>>;
  /** Session tokens seen during the run, redacted from every artifact. */
  readonly secrets: readonly string[];
}

/** Minimal cookie jar: name → value, honouring deletions (Max-Age=0 or an empty value). */
export class CookieJar {
  private readonly cookies: Map<string, string>;

  constructor(initial: Iterable<[string, string]> = []) {
    this.cookies = new Map(initial);
  }

  absorb(response: Response): void {
    for (const raw of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = raw.split(";").map((part) => part.trim());
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const expired = value === "" || attributes.some((attr) => /^max-age=0$/i.test(attr));
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Better Auth's session cookie (`better-auth.session_token`; `__Secure-`-prefixed over https). */
  session(): { name: string; value: string } | undefined {
    for (const [name, value] of this.cookies) {
      if (name.endsWith("session_token")) return { name, value };
    }
    return undefined;
  }

  values(): string[] {
    return [...this.cookies.values()];
  }

  clone(): CookieJar {
    return new CookieJar(this.cookies);
  }
}

interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly ms: number;
}

interface CallOptions {
  readonly jar?: CookieJar;
  readonly json?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

const STEP_TIMEOUT_MS = 15_000;

class FlowDriver {
  readonly steps: FlowStep[] = [];
  readonly notes: Record<string, string> = {};
  private readonly tokens = new Set<string>();

  constructor(
    readonly base: string,
    private readonly signal: AbortSignal,
  ) {}

  async call(method: string, path: string, options: CallOptions = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (options.json !== undefined) headers["content-type"] = "application/json";
    const cookie = options.jar?.header();
    if (cookie) headers.cookie = cookie;
    const started = performance.now();
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers,
      body: options.json === undefined ? undefined : JSON.stringify(options.json),
      redirect: "manual",
      signal: AbortSignal.any([this.signal, AbortSignal.timeout(STEP_TIMEOUT_MS)]),
    });
    const ms = Math.round((performance.now() - started) * 10) / 10;
    options.jar?.absorb(response);
    for (const value of options.jar?.values() ?? []) this.tokens.add(value);
    const text = await response.text();
    let body: unknown = text;
    try {
      body = text === "" ? null : JSON.parse(text);
    } catch {
      // keep the text body
    }
    return { status: response.status, body, ms };
  }

  record(
    step: string,
    request: string,
    expected: number[],
    reply: Reply,
    note: string,
    extraOk = true,
  ): void {
    this.steps.push({
      step,
      request,
      expected: expected.join("|"),
      actual: reply.status,
      ok: expected.includes(reply.status) && extraOk,
      ms: reply.ms,
    });
    this.notes[step] = note;
  }

  secrets(): string[] {
    return [...this.tokens].filter((token) => token.length >= 6);
  }
}

interface Account {
  readonly email: string;
  readonly password: string;
  readonly name: string;
}

const userId = (body: unknown): string | undefined =>
  (body as { user?: { id?: string } } | null)?.user?.id;
const noteList = (body: unknown): { id: string }[] =>
  (body as { notes?: { id: string }[] } | null)?.notes ?? [];
const hasNote = (body: unknown, id: string | undefined): boolean =>
  id !== undefined && noteList(body).some((note) => note.id === id);

/** a–b2: anonymous access is refused; sign-up yields a session for that user. Returns alice's id. */
async function signUpAndSession(
  d: FlowDriver,
  alice: Account,
  jar: CookieJar,
): Promise<string | undefined> {
  let r = await d.call("GET", "/api/notes");
  d.record("a", "GET /api/notes (no cookie)", [401], r, `status ${r.status}`);
  r = await d.call("POST", "/api/auth/sign-up/email", { jar, json: alice });
  const aliceId = userId(r.body);
  const hasSession = jar.session() !== undefined;
  d.record(
    "b",
    "POST /api/auth/sign-up/email (alice)",
    [200],
    r,
    `session cookie set=${hasSession}`,
    hasSession && aliceId !== undefined,
  );
  r = await d.call("GET", "/api/auth/get-session", { jar });
  const same = aliceId !== undefined && userId(r.body) === aliceId;
  d.record(
    "b2",
    "GET /api/auth/get-session (alice)",
    [200],
    r,
    `session user matches=${same}`,
    same,
  );
  return aliceId;
}

/** c–d: a protected write is owned by the session user; invalid input is a 400. Returns the note id. */
async function ownNotes(
  d: FlowDriver,
  jar: CookieJar,
  aliceId: string | undefined,
): Promise<string | undefined> {
  let r = await d.call("POST", "/api/notes", { jar, json: { body: "alice's private note" } });
  const note = (r.body as { note?: { id?: string; userId?: string } } | null)?.note;
  const owned = aliceId !== undefined && note?.userId === aliceId && note?.id !== undefined;
  d.record("c", "POST /api/notes (alice)", [201], r, `note owned by alice=${owned}`, owned);
  r = await d.call("POST", "/api/notes", { jar, json: { body: "" } });
  d.record("c2", "POST /api/notes with an empty body (alice)", [400], r, `status ${r.status}`);
  r = await d.call("GET", "/api/notes", { jar });
  d.record(
    "d",
    "GET /api/notes (alice)",
    [200],
    r,
    `notes=${noteList(r.body).length}`,
    hasNote(r.body, note?.id),
  );
  return note?.id;
}

/** e1–e4: a second user sees nothing of alice's and can't delete her note (404, not 403). */
async function isolation(
  d: FlowDriver,
  bob: Account,
  aliceJar: CookieJar,
  noteId: string | undefined,
): Promise<void> {
  const bobJar = new CookieJar();
  let r = await d.call("POST", "/api/auth/sign-up/email", { jar: bobJar, json: bob });
  const hasSession = bobJar.session() !== undefined;
  d.record(
    "e1",
    "POST /api/auth/sign-up/email (bob)",
    [200],
    r,
    `session cookie set=${hasSession}`,
    hasSession,
  );
  r = await d.call("GET", "/api/notes", { jar: bobJar });
  d.record(
    "e2",
    "GET /api/notes (bob)",
    [200],
    r,
    `notes=${noteList(r.body).length}`,
    noteList(r.body).length === 0,
  );
  r = await d.call("DELETE", `/api/notes/${noteId ?? "missing"}`, { jar: bobJar });
  d.record("e3", "DELETE /api/notes/:aliceNoteId (bob)", [404], r, `status ${r.status}`);
  r = await d.call("GET", "/api/notes", { jar: aliceJar });
  const intact = hasNote(r.body, noteId);
  d.record(
    "e4",
    "GET /api/notes (alice, after bob's delete attempt)",
    [200],
    r,
    `alice's note intact=${intact}`,
    intact,
  );
}

async function forgedCookies(d: FlowDriver, aliceJar: CookieJar): Promise<void> {
  const session = aliceJar.session();
  const name = session?.name ?? "better-auth.session_token";
  const [raw = "", signature = ""] = decodeURIComponent(session?.value ?? "").split(".");
  const flipped = `${raw.slice(0, -1)}${raw.endsWith("A") ? "B" : "A"}.${signature}`;
  const attempts: [string, string, string][] = [
    ["f1", "GET /api/notes (token altered, original signature)", encodeURIComponent(flipped)],
    ["f2", "GET /api/notes (raw token, signature stripped)", encodeURIComponent(raw)],
    ["f3", "GET /api/notes (garbage cookie)", "garbage"],
  ];
  for (const [step, request, value] of attempts) {
    const r = await d.call("GET", "/api/notes", { headers: { cookie: `${name}=${value}` } });
    d.record(step, request, [401], r, `status ${r.status}`);
  }
}

async function originAndCredentials(d: FlowDriver, alice: Account): Promise<void> {
  const signIn = { email: alice.email, password: alice.password };
  let r = await d.call("POST", "/api/auth/sign-in/email", {
    json: signIn,
    headers: { origin: "https://evil.example" },
  });
  d.record(
    "o1",
    "POST /api/auth/sign-in/email with an untrusted Origin",
    [403],
    r,
    `status ${r.status}`,
  );
  r = await d.call("POST", "/api/auth/sign-in/email", {
    json: signIn,
    headers: { origin: d.base },
  });
  d.record(
    "o2",
    "POST /api/auth/sign-in/email with Origin = BETTER_AUTH_URL",
    [200],
    r,
    `status ${r.status}`,
  );
  r = await d.call("POST", "/api/auth/sign-in/email", {
    json: { ...signIn, password: "wrong-password-123" },
  });
  d.record(
    "o3",
    "POST /api/auth/sign-in/email with a wrong password",
    [401],
    r,
    `status ${r.status}`,
  );
  r = await d.call("POST", "/api/auth/sign-up/email", { json: alice });
  d.record(
    "o4",
    "POST /api/auth/sign-up/email with a duplicate email",
    [400, 422],
    r,
    `status ${r.status}`,
  );
}

/** g1–g2: sign-out revokes the server-side session, so the old cookie stops working. */
async function signOut(d: FlowDriver, aliceJar: CookieJar): Promise<void> {
  const before = aliceJar.clone();
  // Better Auth POSTs need a JSON body (the official client sends {}) and a trusted Origin.
  let r = await d.call("POST", "/api/auth/sign-out", {
    jar: aliceJar,
    json: {},
    headers: { origin: d.base },
  });
  d.record(
    "g1",
    "POST /api/auth/sign-out (alice, Origin = BETTER_AUTH_URL)",
    [200],
    r,
    `status ${r.status}`,
  );
  r = await d.call("GET", "/api/notes", { jar: before });
  d.record("g2", "GET /api/notes with the pre-sign-out cookie", [401], r, `status ${r.status}`);
}

/** h1–j2: sign-in restores access; a bearer token is not a credential; the owner can delete. */
async function signInAndDelete(
  d: FlowDriver,
  alice: Account,
  noteId: string | undefined,
): Promise<void> {
  const jar = new CookieJar();
  let r = await d.call("POST", "/api/auth/sign-in/email", {
    jar,
    json: { email: alice.email, password: alice.password },
  });
  const hasSession = jar.session() !== undefined;
  d.record(
    "h1",
    "POST /api/auth/sign-in/email (alice)",
    [200],
    r,
    `session cookie set=${hasSession}`,
    hasSession,
  );
  r = await d.call("GET", "/api/notes", { jar });
  const visible = hasNote(r.body, noteId);
  d.record(
    "h2",
    "GET /api/notes (alice, new session)",
    [200],
    r,
    `own note visible=${visible}`,
    visible,
  );
  r = await d.call("GET", "/api/notes", {
    headers: { authorization: `Bearer ${jar.session()?.value ?? ""}` },
  });
  d.record(
    "i",
    "GET /api/notes with Authorization: Bearer <session token>",
    [401],
    r,
    "cookies are the only credential",
  );
  r = await d.call("DELETE", `/api/notes/${noteId ?? "missing"}`, { jar });
  d.record("j1", "DELETE /api/notes/:id (alice, her own note)", [204], r, `status ${r.status}`);
  r = await d.call("GET", "/api/notes", { jar });
  const gone = noteId !== undefined && !hasNote(r.body, noteId);
  d.record("j2", "GET /api/notes (alice, after deleting it)", [200], r, `note gone=${gone}`, gone);
}

function accounts(): { alice: Account; bob: Account } {
  const nonce = crypto.randomUUID().slice(0, 8);
  return {
    alice: {
      email: `alice-${nonce}@example.com`,
      password: "alice-correct-horse-1",
      name: "Alice",
    },
    bob: { email: `bob-${nonce}@example.com`, password: "bob-correct-horse-2", name: "Bob" },
  };
}

/** Drive the whole flow; a transport failure ends it with a failing "!" step instead of a crash. */
export async function runAuthFlow(base: string, signal: AbortSignal): Promise<FlowRun> {
  const driver = new FlowDriver(base, signal);
  const { alice, bob } = accounts();
  const aliceJar = new CookieJar();
  try {
    const aliceId = await signUpAndSession(driver, alice, aliceJar);
    const noteId = await ownNotes(driver, aliceJar, aliceId);
    await isolation(driver, bob, aliceJar, noteId);
    await forgedCookies(driver, aliceJar);
    await originAndCredentials(driver, alice);
    await signOut(driver, aliceJar);
    await signInAndDelete(driver, alice, noteId);
  } catch (error) {
    driver.steps.push({
      step: "!",
      request: "flow harness",
      expected: "-",
      actual: 0,
      ok: false,
      ms: 0,
    });
    driver.notes["!"] = error instanceof Error ? error.message : String(error);
  }
  return { steps: driver.steps, notes: driver.notes, secrets: driver.secrets() };
}
