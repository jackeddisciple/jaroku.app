import { createElement } from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { markup } from "../lib/testRender.ts";
import { SecretField, secretFieldAttributes } from "./SecretField.tsx";

let fail = 0;
const check = (name: string, ok: boolean, detail = ""): void => {
  if (ok) console.log(`  ok   ${name}`);
  else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` | ${detail}` : ""}`);
  }
};

const HERE = fileURLToPath(new URL(".", import.meta.url));
const PANEL = readFileSync(`${HERE}McpPanel.tsx`, "utf8");
const INBOX = readFileSync(`${HERE}InboxCardActions.tsx`, "utf8");

console.log("\na password manager has no login form to fill");
{
  check("the Connect form holds no password input", !/type="password"/.test(PANEL));
  check("the Inbox credential form holds no password input", !/"password"\}/.test(INBOX));
  check("the Connect form is its own form, so another field on the page cannot join it", /<form[^>]*autoComplete="off"/.test(PANEL));
  check("the name field opts out of autofill", /name="mcp-server-label"[\s\S]{0,200}autoComplete="off"/.test(PANEL));
  check("the endpoint field opts out of autofill", /name="mcp-server-endpoint"[\s\S]{0,200}autoComplete="off"/.test(PANEL));
}

console.log("\nthe field still hides what is typed");
{
  const masked = secretFieldAttributes(true);
  check("where masking exists the field is plain text", masked.type === "text");
  check("...drawn as dots", masked.maskedStyle === true);
  check("...and asks for no autofill", masked.autoComplete === "off");
  const fallback = secretFieldAttributes(false);
  check("where masking is missing it stays hidden as a password field", fallback.type === "password");
  check("...marked new, which browsers will not fill with a saved login", fallback.autoComplete === "new-password");
  check("...and never drawn plain", fallback.maskedStyle === false);

  const html = markup(createElement(SecretField, { name: "x", value: "", onChange: () => {} }));
  check("every common password manager is told to skip it", /data-1p-ignore/.test(html) && /data-lpignore="true"/.test(html) && /data-bwignore/.test(html));
  check("it does not spellcheck a credential", /spellcheck="false"/i.test(html));
}

console.log(fail === 0 ? "\nALL CORRECT" : `\n${fail} FAILURES`);
(globalThis as { process?: { exit(code: number): void } }).process?.exit(fail === 0 ? 0 : 1);
