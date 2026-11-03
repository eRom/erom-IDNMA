import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, type Scalar } from "yaml";
import { ConfigError } from "../src/config/network.ts";
import { GENERIC_SKILL, skillText } from "../src/install/skill.ts";
import { TEAMMATE_END, TEAMMATE_START_CREATED, TEAMMATE_TEXT } from "../src/install/teammate.ts";
import { DST_PATCH_END, DST_PATCH_START, dstPluginPath, dstPluginState, installDst, installDstPatch, uninstallDst, uninstallDstPatch } from "../src/install/dst.ts";

const CLI = join(import.meta.dir, "../src/cli.ts");
const FIXTURE = join(import.meta.dir, "fixtures", "dsh-profile-patch.yml");
const childTest = (title: string, body: () => Promise<void>): void => test(title, body, { timeout: 15_000 });

const PLUGIN = "/tmp/idnma-t-plugin/src/dst/plugin.ts";
const START_SUFFIX = " (ne pas éditer : idnma uninstall --agent dst le retire)";

let dir: string;
let patchPath: string;

beforeEach(() => {
  dir = mkdtempSync("/tmp/idnma-t-");
  patchPath = join(dir, "cordis.patch.yml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Ligne de début attendue pour une variante (`""`, `" eol-added"`, `" created"`, `" empty-list:<base64>"`). */
const startLine = (variant: string): string => `${DST_PATCH_START}${variant}${START_SUFFIX}`;
const bodyFor = (pluginPath: string): string =>
  `- insert:\n    - id: idnma-bridge\n      name: ${JSON.stringify(pluginPath)}\n      disabled: !!js '!process.env.IDNMA_DST_BRIDGE'\n`;
const blockFor = (variant: string, pluginPath: string = PLUGIN): string => `${startLine(variant)}\n${bodyFor(pluginPath)}${DST_PATCH_END}\n`;
const TEAMMATE_CREATED_BLOCK = `${TEAMMATE_START_CREATED}\n${TEAMMATE_TEXT}\n${TEAMMATE_END}\n`;
const modeOf = (path: string): number => statSync(path).mode & 0o777;
const countOf = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const b64 = (text: string): string => Buffer.from(text, "latin1").toString("base64");

const jsTag = { tag: "tag:yaml.org,2002:js", resolve: (value: string) => value };
const reparse = (path: string) => parseDocument(readFileSync(path, "utf8"), { customTags: [jsTag], logLevel: "silent" });

describe("installDstPatch / uninstallDstPatch", () => {
  test("creates the patch file with the block when absent, then removes it", () => {
    expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
    expect(readFileSync(patchPath, "utf8")).toBe(blockFor(" created"));
    expect(modeOf(patchPath)).toBe(0o644);

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(existsSync(patchPath)).toBe(false);
    expect(uninstallDstPatch(patchPath)).toBe("absent");
  });

  test("replaces the [] of the profile patch shipped by dsh, keeps the comments, restores byte for byte", () => {
    const original = readFileSync(FIXTURE);
    writeFileSync(patchPath, original);
    chmodSync(patchPath, 0o600);
    const originalText = original.toString("utf8");
    const emptyLine = "[]\n";
    expect(originalText.endsWith(emptyLine)).toBe(true);

    expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
    const installed = readFileSync(patchPath, "utf8");
    expect(installed).toBe(`${originalText.slice(0, -emptyLine.length)}${blockFor(` empty-list:${b64(emptyLine)}`)}`);
    expect(installed).not.toMatch(/^\[\]$/m);
    expect(modeOf(patchPath)).toBe(0o600);

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath).equals(original)).toBe(true);
    expect(modeOf(patchPath)).toBe(0o600);
  });

  test("restores a [] file with a trailing comment, CRLF endings and no final newline", () => {
    for (const original of ["[] # rien pour l'instant\n", "# c\r\n[]\r\n", "# c\r\n[] # note\r\n", "# c\n  [ ]", "\n\n[]\n\n"]) {
      writeFileSync(patchPath, original);
      expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
      expect(countOf(readFileSync(patchPath, "utf8"), DST_PATCH_START)).toBe(1);
      expect(reparse(patchPath).errors).toEqual([]);
      expect(uninstallDstPatch(patchPath)).toBe("removed");
      expect(readFileSync(patchPath, "utf8")).toBe(original);
    }
  });

  test("a CRLF [] line with a trailing comment is replaced and restored byte for byte", () => {
    const original = "# c\r\n[] # note\r\n";
    writeFileSync(patchPath, original);
    expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
    expect(readFileSync(patchPath, "utf8")).toBe(`# c\r\n${blockFor(` empty-list:${b64("[] # note\r\n")}`)}`);
    expect(reparse(patchPath).errors).toEqual([]);
    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath, "utf8")).toBe(original);
  });

  test("after an [] install, an entry added by l'utilisateur after or before the block keeps the file valid YAML on uninstall", () => {
    const mine = "- id: mine\n  disabled: true\n";
    const cases = [
      { label: "after", edit: (installed: string) => `${installed}${mine}`, expected: `# c\n${mine}` },
      { label: "before", edit: (installed: string) => `# c\n${mine}${installed.slice("# c\n".length)}`, expected: `# c\n${mine}` },
    ];
    for (const { label, edit, expected } of cases) {
      writeFileSync(patchPath, "# c\n[]\n");
      installDstPatch(patchPath, PLUGIN);
      writeFileSync(patchPath, edit(readFileSync(patchPath, "utf8")));

      expect({ label, outcome: uninstallDstPatch(patchPath) }).toEqual({ label, outcome: "removed" });
      const restored = readFileSync(patchPath, "utf8");
      expect({ label, restored }).toEqual({ label, restored: expected });
      const doc = parseDocument(restored, { customTags: [jsTag], logLevel: "silent" });
      expect(doc.errors).toEqual([]);
      expect(doc.toJS()).toEqual([{ id: "mine", disabled: true }]);
    }
  });

  test("an entry added after an [] install is kept with comments only around it, [] untouched when nothing else remains", () => {
    writeFileSync(patchPath, "# c\n[]\n");
    installDstPatch(patchPath, PLUGIN);
    writeFileSync(patchPath, `${readFileSync(patchPath, "utf8")}# fin\n`);
    uninstallDstPatch(patchPath);
    expect(readFileSync(patchPath, "utf8")).toBe("# c\n[]\n# fin\n");
  });

  test("appends to a non-empty list ending with a newline, then restores it", () => {
    const original = "# mes patchs\n- id: autre\n  disabled: true\n";
    writeFileSync(patchPath, original);

    expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
    expect(readFileSync(patchPath, "utf8")).toBe(`${original}${blockFor("")}`);
    const items = reparse(patchPath).toJS() as Array<Record<string, unknown>>;
    expect(items.length).toBe(2);

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath, "utf8")).toBe(original);
  });

  test("adds a newline before the block when the list has no final newline, and takes it back", () => {
    const original = "- id: autre\n  disabled: true";
    writeFileSync(patchPath, original);

    expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
    expect(readFileSync(patchPath, "utf8")).toBe(`${original}\n${blockFor(" eol-added")}`);
    expect(reparse(patchPath).errors).toEqual([]);

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath, "utf8")).toBe(original);
  });

  test("an empty file or a comments-only file gets the block and gets itself back", () => {
    for (const original of ["", "# rien\n"]) {
      writeFileSync(patchPath, original);
      expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
      expect(reparse(patchPath).errors).toEqual([]);
      expect(uninstallDstPatch(patchPath)).toBe("removed");
      expect(readFileSync(patchPath, "utf8")).toBe(original);
    }
  });

  test("is idempotent: a second install reports unchanged and writes nothing", () => {
    writeFileSync(patchPath, readFileSync(FIXTURE));
    expect(installDstPatch(patchPath, PLUGIN)).toBe("installed");
    const first = readFileSync(patchPath);
    const before = statSync(patchPath).mtimeMs;

    expect(installDstPatch(patchPath, PLUGIN)).toBe("unchanged");
    expect(readFileSync(patchPath).equals(first)).toBe(true);
    expect(statSync(patchPath).mtimeMs).toBe(before);
  });

  test("updates the plugin path in place and keeps the original start line", () => {
    writeFileSync(patchPath, readFileSync(FIXTURE));
    installDstPatch(patchPath, PLUGIN);
    const startBefore = readFileSync(patchPath, "utf8").split("\n").find((line) => line.startsWith(DST_PATCH_START));

    const other = "/tmp/idnma-t-other/src/dst/plugin.ts";
    expect(installDstPatch(patchPath, other)).toBe("updated");
    const text = readFileSync(patchPath, "utf8");
    expect(text).toContain(`name: ${JSON.stringify(other)}`);
    expect(text).not.toContain(PLUGIN);
    expect(text.split("\n").find((line) => line.startsWith(DST_PATCH_START))).toBe(startBefore);
    expect(countOf(text, DST_PATCH_START)).toBe(1);

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath).equals(readFileSync(FIXTURE))).toBe(true);
  });

  test("keeps the content that follows the block, on install update and uninstall", () => {
    const before = "# tête\n";
    const after = "- id: apres\n  disabled: true\n";
    writeFileSync(patchPath, `${before}${blockFor("", PLUGIN)}${after}`);

    expect(installDstPatch(patchPath, "/tmp/idnma-t-other/plugin.ts")).toBe("updated");
    const updated = readFileSync(patchPath, "utf8");
    expect(updated.startsWith(before)).toBe(true);
    expect(updated.endsWith(after)).toBe(true);

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath, "utf8")).toBe(`${before}${after}`);
  });

  test("the produced YAML is a sequence whose disabled value carries the !!js tag", () => {
    writeFileSync(patchPath, readFileSync(FIXTURE));
    installDstPatch(patchPath, PLUGIN);

    const doc = reparse(patchPath);
    expect(doc.errors).toEqual([]);
    expect(doc.warnings).toEqual([]);
    expect(doc.toJS()).toEqual([{ insert: [{ id: "idnma-bridge", name: PLUGIN, disabled: "!process.env.IDNMA_DST_BRIDGE" }] }]);
    const disabled = doc.getIn([0, "insert", 0, "disabled"], true) as Scalar;
    expect(disabled.tag).toBe("tag:yaml.org,2002:js");
  });

  test("a non-ASCII plugin path survives the round trip as the right string", () => {
    const accented = "/tmp/idnma-t-x/é/plugin.ts";
    writeFileSync(patchPath, readFileSync(FIXTURE));

    expect(installDstPatch(patchPath, accented)).toBe("installed");
    expect(reparse(patchPath).toJS()).toEqual([{ insert: [{ id: "idnma-bridge", name: accented, disabled: "!process.env.IDNMA_DST_BRIDGE" }] }]);
    expect(dstPluginState(dir, accented)).toEqual({ kind: "installed" });
    expect(installDstPatch(patchPath, accented)).toBe("unchanged");

    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath).equals(readFileSync(FIXTURE))).toBe(true);
  });

  test("keeps the bytes of the user's file that are not valid UTF-8", () => {
    const original = Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from("\n- id: autre\n  disabled: true\n")]);
    writeFileSync(patchPath, original);
    installDstPatch(patchPath, PLUGIN);
    expect(readFileSync(patchPath).subarray(0, original.length).equals(original)).toBe(true);
    expect(uninstallDstPatch(patchPath)).toBe("removed");
    expect(readFileSync(patchPath).equals(original)).toBe(true);
  });

  test("follows a symlinked patch file and keeps the link", () => {
    const real = join(dir, "dotfiles-patch.yml");
    writeFileSync(real, readFileSync(FIXTURE));
    symlinkSync(real, patchPath);

    installDstPatch(patchPath, PLUGIN);
    expect(readFileSync(real, "utf8")).toContain(DST_PATCH_START);
    expect(statSync(patchPath).isFile()).toBe(true);
    expect(readFileSync(patchPath, "utf8")).toBe(readFileSync(real, "utf8"));

    uninstallDstPatch(patchPath);
    expect(readFileSync(real).equals(readFileSync(FIXTURE))).toBe(true);
  });

  test("refuses a shape it cannot extend, without writing", () => {
    const refused = ["[a, b]\n", "key: value\n", "- insert: [\n", "{ a: 1 }\n", "- id: ok\n  bad: [\n"];
    for (const original of refused) {
      writeFileSync(patchPath, original);
      let error: unknown;
      try {
        installDstPatch(patchPath, PLUGIN);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("forme inattendue");
      expect((error as ConfigError).message).toContain("ajoute le bloc à la main");
      expect(readFileSync(patchPath, "utf8")).toBe(original);
    }
  });

  test("refuses inconsistent markers, on install and uninstall, without writing", () => {
    const start = startLine("");
    const cases = [
      `${start}\n${bodyFor(PLUGIN)}`,
      `${bodyFor(PLUGIN)}${DST_PATCH_END}\n`,
      `${blockFor("")}${blockFor("")}`,
      `${DST_PATCH_END}\n${start}\n`,
      `${DST_PATCH_START} (ligne de début éditée)\n${bodyFor(PLUGIN)}${DST_PATCH_END}\n`,
    ];
    for (const original of cases) {
      writeFileSync(patchPath, original);
      expect(() => installDstPatch(patchPath, PLUGIN)).toThrow(ConfigError);
      expect(() => uninstallDstPatch(patchPath)).toThrow(ConfigError);
      expect(() => dstPluginState(dir, PLUGIN)).toThrow(ConfigError);
      expect(readFileSync(patchPath, "utf8")).toBe(original);
    }
  });

  test("uninstall leaves a file without block untouched", () => {
    writeFileSync(patchPath, "# rien à moi\n[]\n");
    expect(uninstallDstPatch(patchPath)).toBe("absent");
    expect(readFileSync(patchPath, "utf8")).toBe("# rien à moi\n[]\n");
  });
});

describe("dstPluginPath", () => {
  test("is the real path of src/dst/plugin.ts of this checkout", () => {
    const path = dstPluginPath();
    expect(path.endsWith("/src/dst/plugin.ts")).toBe(true);
    expect(existsSync(path)).toBe(true);
  });
});

describe("dstPluginState", () => {
  test("absent without file, without block, then installed, then other-checkout", () => {
    expect(dstPluginState(dir, PLUGIN)).toEqual({ kind: "absent" });
    writeFileSync(patchPath, readFileSync(FIXTURE));
    expect(dstPluginState(dir, PLUGIN)).toEqual({ kind: "absent" });

    installDstPatch(patchPath, PLUGIN);
    expect(dstPluginState(dir, PLUGIN)).toEqual({ kind: "installed" });
    expect(dstPluginState(dir, "/tmp/idnma-t-other/plugin.ts")).toEqual({ kind: "other-checkout", path: PLUGIN });
  });

  test("defaults: home from IDNMA_DSH_HOME and the plugin of this checkout", () => {
    const saved = process.env.IDNMA_DSH_HOME;
    process.env.IDNMA_DSH_HOME = dir;
    try {
      installDstPatch(patchPath);
      expect(dstPluginState()).toEqual({ kind: "installed" });
    } finally {
      if (saved === undefined) delete process.env.IDNMA_DSH_HOME;
      else process.env.IDNMA_DSH_HOME = saved;
    }
  });
});

describe("installDst / uninstallDst", () => {
  const withHome = <T>(home: string, body: () => T): T => {
    const saved = process.env.IDNMA_DSH_HOME;
    process.env.IDNMA_DSH_HOME = home;
    try {
      return body();
    } finally {
      if (saved === undefined) delete process.env.IDNMA_DSH_HOME;
      else process.env.IDNMA_DSH_HOME = saved;
    }
  };

  test("reports absent when the dsh home does not exist, creating nothing", () => {
    const missing = join(dir, "no-dsh");
    expect(withHome(missing, installDst)).toBe("absent");
    expect(withHome(missing, uninstallDst)).toBe("absent");
    expect(existsSync(missing)).toBe(false);
  });

  test("installs the patch, the teammate block and the skill, then takes everything back", () => {
    const home = join(dir, "dsh");
    mkdirSync(home);
    const original = readFileSync(FIXTURE);
    writeFileSync(join(home, "cordis.patch.yml"), original);

    expect(withHome(home, installDst)).toBe("installed");
    expect(readFileSync(join(home, "cordis.patch.yml"), "utf8")).toContain(`name: ${JSON.stringify(dstPluginPath())}`);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe(TEAMMATE_CREATED_BLOCK);
    expect(readFileSync(join(home, "skills", GENERIC_SKILL, "SKILL.md"), "utf8")).toBe(skillText(GENERIC_SKILL));
    expect(withHome(home, installDst)).toBe("unchanged");

    expect(withHome(home, uninstallDst)).toBe("removed");
    expect(readFileSync(join(home, "cordis.patch.yml")).equals(original)).toBe(true);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, "skills"))).toBe(false);
    expect(withHome(home, uninstallDst)).toBe("absent");
  });

  test("a refused patch shape stops the install before AGENTS.md and the skill", () => {
    const home = join(dir, "dsh");
    mkdirSync(home);
    writeFileSync(join(home, "cordis.patch.yml"), "key: value\n");
    expect(() => withHome(home, installDst)).toThrow(ConfigError);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, "skills"))).toBe(false);
  });

  test("leaves a neighbour skill and an existing AGENTS.md of the user alone", () => {
    const home = join(dir, "dsh");
    mkdirSync(join(home, "skills", "autre"), { recursive: true });
    writeFileSync(join(home, "skills", "autre", "SKILL.md"), "# autre\n");
    writeFileSync(join(home, "AGENTS.md"), "# Mes règles\n");

    withHome(home, installDst);
    withHome(home, uninstallDst);
    expect(readFileSync(join(home, "AGENTS.md"), "utf8")).toBe("# Mes règles\n");
    expect(readFileSync(join(home, "skills", "autre", "SKILL.md"), "utf8")).toBe("# autre\n");
    expect(existsSync(join(home, "skills", GENERIC_SKILL))).toBe(false);
  });
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Lance `bun src/cli.ts …` avec un environnement purgé de la doublure et tous les dossiers d'agents redirigés. */
async function cli(args: string[], dshHome: string): Promise<CliResult> {
  const { IDNMA_NAME: _a, IDNMA_CONTROL_SOCKET: _b, IDNMA_CONTROL_TOKEN: _c, CODEX_THREAD_ID: _d, DSH_HOME: _e, ...cleanEnv } = process.env;
  const env = {
    ...cleanEnv,
    IDNMA_DSH_HOME: dshHome,
    CODEX_HOME: join(dir, "no-codex"),
    CLAUDE_CONFIG_DIR: join(dir, "no-claude"),
    GROK_HOME: join(dir, "no-grok"),
    IDNMA_AGY_PLUGINS_DIR: join(dir, "no-agy", "plugins"),
    IDNMA_AGY_BIN: join(dir, "no-agy", "bin"),
    IDNMA_OPENCODE_CONFIG_DIR: join(dir, "no-opencode"),
  };
  const child = Bun.spawn(["bun", CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("idnma install / uninstall --agent dst", () => {
  childTest("an absent dsh home is reported and nothing is created", async () => {
    const missing = join(dir, "no-dsh");
    const installed = await cli(["install", "--agent", "dst"], missing);
    expect(installed).toEqual({ code: 0, stdout: `dst : absent (${missing}), rien installé\n`, stderr: "" });
    const removed = await cli(["uninstall", "--agent", "dst"], missing);
    expect(removed).toEqual({ code: 0, stdout: `dst : rien à retirer de ${missing}\n`, stderr: "" });
    expect(existsSync(missing)).toBe(false);
  });

  childTest("install then uninstall lay down and take back the three files", async () => {
    const home = join(dir, "dsh");
    mkdirSync(home);
    const original = readFileSync(FIXTURE);
    writeFileSync(join(home, "cordis.patch.yml"), original);

    const first = await cli(["install", "--agent", "dst"], home);
    expect(first).toEqual({ code: 0, stdout: `dst : plugin, ligne coéquipier et skill installés dans ${home}\n`, stderr: "" });
    expect(readFileSync(join(home, "cordis.patch.yml"), "utf8")).toContain(`name: ${JSON.stringify(dstPluginPath())}`);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(home, "skills", GENERIC_SKILL, "SKILL.md"))).toBe(true);

    const second = await cli(["install", "--agent=dst"], home);
    expect(second.stdout).toBe(`dst : plugin, ligne coéquipier et skill déjà à jour dans ${home}\n`);

    const removed = await cli(["uninstall", "--agent", "dst"], home);
    expect(removed).toEqual({ code: 0, stdout: `dst : plugin, ligne coéquipier et skill retirés de ${home}\n`, stderr: "" });
    expect(readFileSync(join(home, "cordis.patch.yml")).equals(original)).toBe(true);
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(home, "skills"))).toBe(false);

    const again = await cli(["uninstall", "--agent", "dst"], home);
    expect(again.stdout).toBe(`dst : rien à retirer de ${home}\n`);
  });

  childTest("a refused patch shape exits 1 with the French message and writes nothing", async () => {
    const home = join(dir, "dsh");
    mkdirSync(home);
    writeFileSync(join(home, "cordis.patch.yml"), "key: value\n");
    const result = await cli(["install", "--agent", "dst"], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("forme inattendue");
    expect(readFileSync(join(home, "cordis.patch.yml"), "utf8")).toBe("key: value\n");
    expect(existsSync(join(home, "AGENTS.md"))).toBe(false);
  });

  childTest("the helps name dst, its two files, and the usage error lists it", async () => {
    for (const command of ["install", "uninstall"]) {
      const help = await cli([command, "--help"], dir);
      expect(help.stdout).toContain("dst");
      expect(help.stdout).toContain("cordis.patch.yml");
      expect(help.stdout).toContain("agy, claude, codex, dst, grok, opencode");
      expect(help.stdout).not.toContain("—");
    }
  });
});
