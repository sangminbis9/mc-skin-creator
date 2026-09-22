import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { expect, it } from "vitest";

type AclRestriction = {
  aclRestricted: boolean;
  inheritanceDisabled: boolean;
  currentUserAccessPresent: boolean;
  systemAccessPresent: boolean;
  broadInheritedAccessPresent: boolean;
  unexpectedAccessPresent: boolean;
};

const support = createRequire(import.meta.url)("./primaryAuditCliHealthSupport.cjs") as {
  currentUserIdentity(options?: { whoamiPath?: string }): { account: string; sid: string };
  inspectTemporaryDirectoryAcl(directory: string): AclRestriction;
  inspectInheritedFileAcl(file: string): {
    inheritedFromRestrictedDirectory: boolean;
    unexpectedAccessPresent: boolean;
  };
  restrictTemporaryDirectory(directory: string, options?: {
    icaclsPath?: string;
    whoamiPath?: string;
  }): AclRestriction;
};

function withTemporaryDirectory(prefix: string, operation: (directory: string) => void) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try { operation(directory); }
  finally {
    const resolved = path.resolve(directory);
    expect(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)).toBe(true);
    if (fs.existsSync(resolved)) fs.rmSync(resolved, { recursive: true, force: true });
  }
  expect(fs.existsSync(directory)).toBe(false);
}

it("uses icacls to restrict a spaced temp path and preserves safe file lifecycle", () => {
  withTemporaryDirectory("mc skin acl ", directory => {
    const identity = support.currentUserIdentity();
    expect(identity.sid).toMatch(/^S-\d+(?:-\d+)+$/);

    const result = support.restrictTemporaryDirectory(directory);
    expect(result).toEqual({
      aclRestricted: true,
      inheritanceDisabled: true,
      currentUserAccessPresent: true,
      systemAccessPresent: true,
      broadInheritedAccessPresent: false,
      unexpectedAccessPresent: false,
    });
    expect(JSON.stringify(result)).not.toContain("S-1-");
    expect(JSON.stringify(result)).not.toContain(identity.account);
    expect(fs.readdirSync(directory)).toEqual([]);

    const inspected = support.inspectTemporaryDirectoryAcl(directory);
    expect(inspected).toEqual(result);

    const file = path.join(directory, "synthetic file.txt");
    fs.writeFileSync(file, "synthetic-non-secret", { flag: "wx" });
    expect(fs.readFileSync(file, "utf8")).toBe("synthetic-non-secret");
    expect(support.inspectInheritedFileAcl(file)).toEqual({
      inheritedFromRestrictedDirectory: true,
      unexpectedAccessPresent: false,
    });
    expect(fs.readdirSync(directory)).toEqual(["synthetic file.txt"]);
    fs.unlinkSync(file);
    expect(fs.existsSync(file)).toBe(false);
  });
});

it("fails closed when icacls is unavailable or cannot apply an ACL", () => {
  withTemporaryDirectory("mc-skin-acl-failure-", directory => {
    const missing = path.join(directory, "missing-icacls.exe");
    expect(() => support.restrictTemporaryDirectory(directory, { icaclsPath: missing }))
      .toThrow("windows_icacls_unavailable");
    expect(() => support.restrictTemporaryDirectory(path.join(directory, "missing-target")))
      .toThrow("windows_icacls_failed");
  });
});

it("fails closed when the current-user SID cannot be acquired", () => {
  withTemporaryDirectory("mc-skin-sid-failure-", directory => {
    const missing = path.join(directory, "missing-whoami.exe");
    expect(() => support.currentUserIdentity({ whoamiPath: missing }))
      .toThrow("current_user_sid_unavailable");
    expect(() => support.restrictTemporaryDirectory(directory, { whoamiPath: missing }))
      .toThrow("current_user_sid_unavailable");
  });
});

it("removes the Set-Acl operational dependency", () => {
  const source = fs.readFileSync(path.resolve("test/primaryAuditCliHealthSupport.cjs"), "utf8");
  expect(source).not.toContain("Set-Acl");
  expect(source).toContain('windowsExecutable("icacls.exe"');
  expect(source).toContain('windowsExecutable("whoami.exe"');
});
