/**
 * The recipes' dotenv reader against Bun itself: util.parseEnv runs the
 * parser Bun loads .env files with (expansion aside), and one real .env.local
 * load pins the placeholders the auth recipe refuses to what an app sees.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { dotenvValues } from "./dotenv.ts";
import { removeScratchDirs, scratchDir } from "./recipes/testing/fixtures.ts";

afterAll(removeScratchDirs);

/**
 * Dotenv forms where Bun 1.3 and 1.4 agree. (They differ on a quoted value
 * followed by more text on its line, and on a leading byte-order mark.)
 */
const FORMS = [
  "K=",
  "K= # generate with openssl rand -base64 32",
  'K="" # set me',
  "K=``",
  "K=''",
  "K=   ",
  "export K=",
  'K="   "',
  "K=abc # note",
  "K=abc#def",
  'K="abc#def" # note',
  "K='a b' # note",
  'K=`it\'s "quoted"`',
  'K="a\\nb"',
  "K='a\\nb'",
  'K="line1\nline2"',
  'K="crlf\r\ninside"',
  "K=`multi\nline`",
  "export K = abc",
  "  export   K = abc",
  "K: abc",
  "K:abc",
  "#K=abc",
  " # K=abc",
  "K=abc\nK=",
  "K=\nK=abc",
  'CERT="begin\nK=abc\nend"',
  'K="unterminated',
  "K=\r\nL=1",
  "K=abc\r\nL=1",
  'K=\n"abc"',
  "K=a=b",
  "K==abc",
  'K="x"#c',
  "K='x' # c",
  'K="a\\"b"',
  "K='a\\'b'",
  "K=\t# tab comment",
  "K.X=1\nK=2",
  "K-X=1",
  "K\n=abc",
  "export K",
  "K= value with  spaces  ",
  "K=#",
  "K=$OTHER",
  "K",
];

describe("dotenvValues", () => {
  test.each(FORMS.map((form) => [form]))("%j reads as Bun's own dotenv parser reads it", (form) => {
    // Arrange
    const text = `${form}\n`;
    // Act
    const ours = dotenvValues(text).get("K") ?? null;
    // Assert
    expect(ours).toBe(parseEnv(text).K ?? null);
  });

  test("the placeholders the auth recipe refuses load as empty strings in a real app", () => {
    // Arrange
    const root = scratchDir("dotenv-load");
    const text = [
      "A=",
      "B= # generate with openssl rand -base64 32",
      'C="" # set me',
      "D=``",
      "E=kept-0123456789abcdef # a note",
    ].join("\n");
    writeFileSync(join(root, ".env.local"), `${text}\n`);
    // Act — a clean environment: an inherited NODE_ENV=test would skip .env.local.
    const loaded = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'console.log(JSON.stringify(["A","B","C","D","E"].map((n) => process.env[n])))',
      ],
      { cwd: root, env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" },
    );
    // Assert
    expect(loaded.exitCode).toBe(0);
    const values = JSON.parse(loaded.stdout.toString());
    expect(values).toEqual(["", "", "", "", "kept-0123456789abcdef"]);
    const ours = dotenvValues(text);
    expect(["A", "B", "C", "D", "E"].map((name) => ours.get(name))).toEqual(values);
  });
});
