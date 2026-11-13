// index.mjs — executor adapter registry. Add an adapter = add a file + one line here.
import claude from "./claude.mjs";
import codex from "./codex.mjs";
import pi from "./pi.mjs";
import deepseekText from "./deepseek-text.mjs";

export const ADAPTERS = { claude, codex, pi, "deepseek-text": deepseekText };
export { classifyFailure, parseReset } from "./classify.mjs";
