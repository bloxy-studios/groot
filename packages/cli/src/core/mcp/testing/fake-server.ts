/** Test entry: the real `runMcp` server wired to the fake core API. */
import { runMcp } from "../server.ts";
import { createFakeApi } from "./fake-api.ts";

await runMcp(createFakeApi(), process.cwd());
