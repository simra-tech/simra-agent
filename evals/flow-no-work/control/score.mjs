// The control variant of flow-no-work: the timing script works. See ../score.mjs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { score as base } from "../score.mjs";

const expected = JSON.parse(readFileSync(new URL("expected.json", import.meta.url), "utf8"));
export const score = (ws) => base(ws, expected);

if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(score(resolve(process.argv[2] ?? ".")), null, 2));
