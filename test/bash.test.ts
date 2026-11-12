import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractBashTargets } from "../src/bash.ts";

async function inProject(run: (cwd: string, home: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-rules-bash-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await mkdir(path.join(cwd, "sub"), { recursive: true });
  await mkdir(path.join(cwd, "dir"), { recursive: true });
  await mkdir(home, { recursive: true });
  for (const file of ["a.ts", "a.sh", "x.js", "sub/y.go", "z.pl"]) await writeFile(path.join(cwd, file), "", "utf8");
  try {
    await run(cwd, home);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function targets(command: string, cwd: string, home: string) {
  const result = await extractBashTargets(command, cwd, home);
  const show = (absolutePath: string) =>
    absolutePath.startsWith(`${cwd}/`) ? absolutePath.slice(cwd.length + 1) : absolutePath.replace(home, "~");
  return {
    writes: result.writes.map((target) => show(target.absolutePath)),
    reads: result.reads.map((target) => show(target.absolutePath)),
  };
}

test("finds the files that a command writes", async () => {
  await inProject(async (cwd, home) => {
    const cases: Array<[string, string[]]> = [
      ["sed -i 's/a/b/' a.ts", ["a.ts"]],
      ["sed -i.bak -e 's/a/b/' a.ts sub/y.go", ["a.ts", "sub/y.go"]],
      ["cd sub && sed -i 's/a/b/' y.go", ["sub/y.go"]],
      ["echo hi >> ~/.zshrc", ["~/.zshrc"]],
      ["cat a.sh | tee -a /tmp/pi-rules-b.sh", ["/tmp/pi-rules-b.sh"]],
      ["cp a.ts dir", ["dir/a.ts"]],
      ["cp a.ts x.js sub/", ["sub/a.ts", "sub/x.js"]],
      ["mv a.ts renamed.ts", ["renamed.ts"]],
      ["perl -pi -e 's/a/b/' z.pl", ["z.pl"]],
      ["sudo FOO=1 touch new.md", ["new.md"]],
      ["printf 'x' > out.txt 2>&1", ["out.txt"]],
      ["node x.js &> log.txt", ["log.txt"]],
      ["cat > notes.md <<EOF\n> not a redirect\nrm -rf /\nEOF", ["notes.md"]],
    ];
    for (const [command, writes] of cases) {
      assert.deepEqual((await targets(command, cwd, home)).writes, writes, command);
    }
  });
});

test("does not count text, file descriptors, or heredoc code as writes", async () => {
  await inProject(async (cwd, home) => {
    const commands = [
      "node x.js 2>&1 >/dev/null",
      'git commit -m "fix > x"',
      "sed -n 1,5p a.ts",
      "python3 - <<'PY'\nopen('a.ts', 'w').write('x')\nPY",
      "cat <<< 'a > b'",
      "ls *.ts # > comment",
    ];
    for (const command of commands) {
      assert.deepEqual((await targets(command, cwd, home)).writes, [], command);
    }
  });
});

test("finds existing files that a command reads", async () => {
  await inProject(async (cwd, home) => {
    assert.deepEqual(await targets("cat a.sh | tee -a /tmp/pi-rules-b.sh", cwd, home), {
      writes: ["/tmp/pi-rules-b.sh"],
      reads: ["a.sh"],
    });
    assert.deepEqual((await targets("node x.js missing.js --flag", cwd, home)).reads, ["x.js"]);
    assert.deepEqual((await targets("cd sub; wc -l y.go < ../a.ts", cwd, home)).reads, ["a.ts", "sub/y.go"]);
    assert.deepEqual((await targets("sed -i 's/a/b/' a.ts", cwd, home)).reads, []);
  });
});

test("a command that the parser rejects has no targets", async () => {
  await inProject(async (cwd, home) => {
    assert.deepEqual(await targets("echo ${name/ b} > out.txt", cwd, home), { writes: [], reads: [] });
  });
});
