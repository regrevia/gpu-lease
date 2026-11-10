// 装到这台 Windows 上，让 `gpulease` 在任何终端里都能直接敲。
//
// 只做四件事：把 exe 放稳、把它加进用户 PATH、放一个开始菜单快捷方式、按需要开机自启 daemon。
// 每一步都只说"做了什么"，失败就说清哪一步失败、原话是什么——不假装成功。

import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, IS_WIN } from "./collect/exec";
import { stateDir } from "./paths";

export const BUNDLED_EXE = "gpulease.exe";
const RUN_KEY = "gpulease";
const SHORTCUT_NAME = "gpulease.lnk";
const START_MENU_FOLDER = "gpu-lease";

export type InstallOptions = {
  dir?: string;
  autostart?: boolean;
  startMenu?: boolean;
  json?: boolean;
};

export type InstallRoots = {
  binDir: string;
  exe: string;
  shortcut: string;
  runKey: string;
  runValue: string;
};

/** Windows 路径一律用反斜杠拼：装上之后 exe 才会出现在 C:\... 而不是 C:/... */
export function winJoin(...parts: string[]): string {
  return parts
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/^[\\/]+/, "").replace(/[\\/]+$/, ""))
    .join("\\");
}

export function installRoots(
  env: Record<string, string | undefined> = process.env,
  opts: Pick<InstallOptions, "dir"> = {},
): InstallRoots {
  const local = env.LOCALAPPDATA || env.APPDATA || winJoin(env.USERPROFILE || "", "AppData", "Local");
  const roaming = env.APPDATA || winJoin(local, "..", "Roaming");
  const binDir = opts.dir?.trim() ? opts.dir.trim() : winJoin(local, "gpulease", "bin");
  return {
    binDir,
    exe: winJoin(binDir, BUNDLED_EXE),
    shortcut: winJoin(roaming, "Microsoft", "Windows", "Start Menu", "Programs", START_MENU_FOLDER, SHORTCUT_NAME),
    runKey: RUN_KEY,
    runValue: "",
  };
}

/** 往 PATH 里加一段：已经有了就不重复加，也不改大小写。Windows 上分号分隔、不区分大小写。
 *  已有的段落原样保留——安装不该顺手把别人的 PATH 重排、去空格、改大小写，
 *  否则卸载后没法还原成装之前那一串。 */
export function mergePath(existing: string, addition: string, win = IS_WIN): string {
  const sep = win ? ";" : ":";
  const norm = (s: string): string => (win ? s.trim().toLowerCase() : s.trim());
  const want = norm(addition);
  const parts = existing.split(sep);
  if (parts.some((p) => p.trim() !== "" && norm(p) === want)) return existing;
  const base = existing.replace(trailingSeps(sep), "");
  return base ? `${base}${sep}${addition}` : addition;
}

/** PATH 里去掉一段（卸载用）；只摘掉这一段，其余段落（含原来的空段、空格、大小写）原样保留。
 *  找不到就原样返回；摘掉后如果什么都不剩，返回空串，调用方负责把变量删掉而不是写成 ""。 */
export function dropPath(existing: string, target: string, win = IS_WIN): string {
  const sep = win ? ";" : ":";
  const norm = (s: string): string => (win ? s.trim().toLowerCase() : s.trim());
  const want = norm(target);
  const kept = existing.split(sep).filter((p) => !(p.trim() !== "" && norm(p) === want));
  return kept.join(sep).replace(edgeSeps(sep), "");
}

function trailingSeps(sep: string): RegExp {
  return new RegExp(`[${sep}]+$`);
}

function edgeSeps(sep: string): RegExp {
  return new RegExp(`^[${sep}]+|[${sep}]+$`, "g");
}

/** 开机自启命令行：路径带空格时必须加引号，否则注册表原话会被劈开。 */
export function autostartValue(exe: string, extra: string[] = ["daemon", "--quiet"]): string {
  return `"${exe}" ${extra.join(" ")}`;
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function powershell(script: string): Promise<string> {
  const res = await exec(["powershell", "-NoProfile", "-NonInteractive", "-Command", script], {
    timeoutMs: 15_000,
  });
  if (res.code !== 0) throw new Error(res.stderr.trim() || res.stdout.trim() || `powershell 退出码 ${res.code}`);
  return res.stdout.trim();
}

async function currentUserPath(): Promise<string> {
  return powershell(`[Environment]::GetEnvironmentVariable('PATH','User')`);
}

async function setUserPath(value: string): Promise<void> {
  await powershell(`[Environment]::SetEnvironmentVariable('PATH',${psQuote(value)},'User')`);
}

async function clearUserPath(): Promise<void> {
  await powershell(`[Environment]::SetEnvironmentVariable('PATH',$null,'User')`);
}

async function makeShortcut(shortcut: string, exe: string, args: string): Promise<void> {
  const script = [
    `$p = Split-Path -Parent ${psQuote(shortcut)}`,
    `New-Item -ItemType Directory -Force -Path $p | Out-Null`,
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcut)})`,
    `$s.TargetPath = ${psQuote(exe)}`,
    `$s.Arguments = ${psQuote(args)}`,
    `$s.WorkingDirectory = Split-Path -Parent ${psQuote(exe)}`,
    `$s.Description = 'gpulease 显卡值班'`,
    `$s.Save()`,
  ].join("; ");
  await powershell(script);
}

async function setRunValue(name: string, value: string): Promise<void> {
  const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  await powershell(
    `New-Item -Path ${psQuote(key)} -Force | Out-Null; New-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(name)} -Value ${psQuote(value)} -PropertyType String -Force | Out-Null`,
  );
}

async function clearRunValue(name: string): Promise<boolean> {
  const key = "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
  const out = await powershell(
    `$k = Get-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(name)} -ErrorAction SilentlyContinue; if ($null -eq $k) { 'missing' } else { Remove-ItemProperty -Path ${psQuote(key)} -Name ${psQuote(name)} -Force; 'removed' }`,
  );
  return out.includes("removed");
}

/** 正在跑的 exe 在 Windows 上删不掉、也覆盖不了：先改名，再把旧文件挪开。 */
function replaceSelf(target: string): { replaced: boolean; from: string } {
  const from = process.execPath;
  if (!existsSync(from)) throw new Error(`找不到自己的可执行文件：${from}`);
  mkdirSync(dirname(target), { recursive: true });
  try {
    if (existsSync(target)) renameSync(target, `${target}.old`);
  } catch {
    // 目标没在跑的话直接覆盖即可；改名失败就交给下面的 copy 去报错。
  }
  if (from.toLowerCase() === target.toLowerCase()) {
    return { replaced: false, from };
  }
  copyFileSync(from, target);
  return { replaced: true, from };
}

function cleanupOld(target: string): boolean {
  const old = `${target}.old`;
  if (!existsSync(old)) return true;
  try {
    rmSync(old, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function commandInstall(argv: string[]): Promise<number> {
  const opts = parseInstallOptions(argv);
  if (!IS_WIN) {
    console.error("install 只支持 Windows：这台机器上的 gpulease 请直接用 `gpulease run`。");
    return 1;
  }
  if (/(^|[\\/])bun(\.exe)?$/i.test(process.execPath)) {
    console.error("install 要用编译出来的 gpulease.exe 跑，不能用 bun 直接跑源码（那样装进去的是 bun）。");
    return 1;
  }

  const roots = installRoots(process.env, opts);
  const done: string[] = [];
  try {
    const { replaced, from } = replaceSelf(roots.exe);
    done.push(replaced ? `exe → ${roots.exe}（从 ${from} 复制）` : `exe 已在 ${roots.exe}`);

    const path = await currentUserPath();
    if (!path.split(";").some((p) => p.trim().toLowerCase() === roots.binDir.toLowerCase())) {
      await setUserPath(mergePath(path, roots.binDir));
      done.push(`PATH（用户级）加入 ${roots.binDir}`);
    } else {
      done.push(`PATH 里已有 ${roots.binDir}`);
    }

    if (opts.startMenu !== false) {
      await makeShortcut(roots.shortcut, roots.exe, "watch");
      done.push(`开始菜单快捷方式 → ${roots.shortcut}`);
    } else {
      done.push("跳过开始菜单快捷方式（--no-start-menu）");
    }

    if (opts.autostart) {
      await setRunValue(roots.runKey, autostartValue(roots.exe));
      done.push(`开机自启已开（HKCU\\...\\Run\\${roots.runKey} → "${roots.exe}" daemon --quiet）`);
    }

    const cleaned = cleanupOld(roots.exe);
    if (!cleaned) done.push(`旧版本 ${roots.exe}.old 还占着，重启后再删`);

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            bin_dir: roots.binDir,
            exe: roots.exe,
            shortcut: opts.startMenu === false ? null : roots.shortcut,
            autostart: opts.autostart === true,
            replaced,
            done,
          },
          null,
          2,
        ),
      );
      return 0;
    }
    console.log("装好了：");
    for (const line of done) console.log(`  - ${line}`);
    console.log("");
    console.log("新开的终端里直接敲 `gpulease ls`。当前这个窗口还没继承新 PATH，要么重开，要么先用完整路径。");
    if (opts.autostart) console.log("开机自启已开：登录后 daemon 自己起来；`gpulease uninstall` 会关掉它。");
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`装到一半失败了：${msg}`);
    console.error(`已经做完的步骤：${done.length ? done.join("；") : "无"}`);
    return 1;
  }
}

export async function commandUninstall(argv: string[]): Promise<number> {
  const opts = parseUninstallOptions(argv);
  if (!IS_WIN) {
    console.error("uninstall 只支持 Windows。");
    return 1;
  }
  const roots = installRoots(process.env, opts);
  const done: string[] = [];
  const problems: string[] = [];

  try {
    if (await clearRunValue(roots.runKey)) done.push(`开机自启已关（删掉 Run\\${roots.runKey}）`);

    if (existsSync(roots.shortcut)) {
      rmSync(roots.shortcut, { force: true });
      try {
        rmSync(dirname(roots.shortcut), { recursive: true, force: true });
      } catch {
        /* 文件夹里还有别的东西就留着 */
      }
      done.push("开始菜单快捷方式已删");
    }

    const path = await currentUserPath();
    const next = dropPath(path, roots.binDir);
    if (next !== path) {
      // 摘完什么都不剩就把变量删掉；写成空串等于留了个 ""，装之前没有 PATH 的机器还原不回去。
      if (next) await setUserPath(next);
      else await clearUserPath();
      done.push(`PATH 里去掉 ${roots.binDir}`);
    }

    if (opts.purge) {
      const running = process.execPath.toLowerCase() === roots.exe.toLowerCase();
      if (running) {
        // 正在跑的就是要删的那个：改个名，让用户重开终端后它自然消失。
        try {
          renameSync(roots.exe, `${roots.exe}.old`);
          done.push(`程序文件已改名 ${roots.exe}.old（这个进程退出后可以删）`);
        } catch (err) {
          problems.push(`程序文件删不掉：${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (existsSync(roots.exe)) {
        rmSync(roots.exe, { force: true });
        done.push(`程序文件已删 ${roots.exe}`);
      }
      const dir = stateDir();
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        done.push(`状态目录已删 ${dir}（任务账本、历史、日志都在里面）`);
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ done, problems, purged: opts.purge === true }, null, 2));
      return problems.length ? 1 : 0;
    }
    if (!done.length) console.log("没找到装过的痕迹，什么也没动。");
    else {
      console.log("卸了：");
      for (const line of done) console.log(`  - ${line}`);
    }
    if (!opts.purge && existsSync(roots.exe)) console.log("程序文件还在（要连它一起删加 --purge）。");
    for (const p of problems) console.error(`有问题：${p}`);
    return problems.length ? 1 : 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`卸载失败：${msg}`);
    return 1;
  }
}

export function parseInstallOptions(argv: string[]): InstallOptions & { purge?: boolean } {
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    dir: value("--dir"),
    autostart: argv.includes("--autostart"),
    startMenu: argv.includes("--no-start-menu") ? false : undefined,
    json: argv.includes("--json"),
  };
}

export function parseUninstallOptions(argv: string[]): InstallOptions & { purge?: boolean } {
  return {
    dir: (argv.indexOf("--dir") >= 0 ? argv[argv.indexOf("--dir") + 1] : undefined) as string | undefined,
    purge: argv.includes("--purge"),
    json: argv.includes("--json"),
  };
}

/** 给 HELP 和 doctor 用的自述：装在哪、在不在 PATH 上、有没有自启。 */
export function installSummary(env: Record<string, string | undefined> = process.env): string {
  const roots = installRoots(env);
  const here = process.execPath.toLowerCase() === roots.exe.toLowerCase() ? "（就是当前这个 exe）" : "";
  return `装到 ${roots.binDir}${here}`;
}

