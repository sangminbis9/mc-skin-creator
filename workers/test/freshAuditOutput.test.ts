import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { freshAuditOutput } from "./freshAuditOutput";

it("uses unique fresh roots by default", () => {
  const parent = mkdtempSync("evaluation-artifacts/fresh-output-guard-");
  const first = freshAuditOutput(join(parent, "run-"));
  const second = freshAuditOutput(join(parent, "run-"));
  expect(first).not.toBe(second);
  expect(readdirSync(first)).toEqual([]);
  expect(readdirSync(second)).toEqual([]);
});

it("reserves an explicit root once and rejects reuse without changing stored bytes", () => {
  const parent = mkdtempSync("evaluation-artifacts/fresh-output-guard-");
  const destination = join(parent, "explicit");
  expect(freshAuditOutput(join(parent, "unused-"), destination)).toBe(destination);
  writeFileSync(join(destination, "evidence.json"), '{"immutable":true}', { flag: "wx" });
  expect(() => freshAuditOutput(join(parent, "unused-"), destination)).toThrow();
  expect(readFileSync(join(destination, "evidence.json"), "utf8")).toBe('{"immutable":true}');
  expect(readdirSync(destination)).toEqual(["evidence.json"]);
});

it("rejects an empty override and does not silently create a replacement root", () => {
  const parent = mkdtempSync("evaluation-artifacts/fresh-output-guard-");
  expect(() => freshAuditOutput(join(parent, "run-"), " ")).toThrow("empty_audit_output_override");
  expect(readdirSync(parent)).toEqual([]);
});
