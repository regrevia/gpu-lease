import { test, expect, describe } from "bun:test";
import {
  autostartValue,
  dropPath,
  installRoots,
  mergePath,
  parseInstallOptions,
  parseUninstallOptions,
} from "../install";

const ENV = {
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
};

describe("安装落点", () => {
  test("默认装到 %LOCALAPPDATA%\\gpulease\\bin，快捷方式在开始菜单", () => {
    const r = installRoots(ENV);
    expect(r.binDir).toBe("C:\\Users\\me\\AppData\\Local\\gpulease\\bin");
    expect(r.exe).toBe("C:\\Users\\me\\AppData\\Local\\gpulease\\bin\\gpulease.exe");
    expect(r.shortcut).toContain("Start Menu\\Programs\\gpu-lease\\gpulease.lnk");
  });

  test("--dir 覆盖落点，其余仍在用户目录下", () => {
    const r = installRoots(ENV, { dir: "D:\\tools\\gpulease" });
    expect(r.exe).toBe("D:\\tools\\gpulease\\gpulease.exe");
    expect(r.shortcut).toContain("AppData\\Roaming");
  });

  test("没有 LOCALAPPDATA 时退回 APPDATA", () => {
    const r = installRoots({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
    expect(r.binDir).toContain("gpulease");
  });
});

describe("PATH 合并", () => {
  test("已有的不重复加", () => {
    const p = "C:\\Windows;C:\\tools";
    expect(mergePath(p, "C:\\tools", true)).toBe(p);
  });

  test("不区分大小写；已经有了就原样返回，不去尾部分号、不重排", () => {
    expect(mergePath("C:\\Tools;", "c:\\tools", true)).toBe("C:\\Tools;");
    expect(mergePath("C:\\a ; C:\\Tools", "c:\\tools", true)).toBe("C:\\a ; C:\\Tools");
  });

  test("加进去时已有的段落一个字节都不动", () => {
    expect(mergePath("C:\\a ; C:\\b;", "C:\\x", true)).toBe("C:\\a ; C:\\b;C:\\x");
  });

  test("装完再卸，PATH 回到装之前那一串（段落顺序、空格、空段都不动）", () => {
    const bin = "C:\\Users\\me\\AppData\\Local\\gpulease\\bin";
    for (const before of ["C:\\a;C:\\b", "C:\\a ;C:\\b", "C:\\a;;C:\\b", ""]) {
      expect(dropPath(mergePath(before, bin, true), bin, true)).toBe(before);
    }
  });

  test("原来以分号结尾的，装的时候会去掉那个尾分号（PATH 里不留空段），卸完是去掉尾分号的那一串", () => {
    const bin = "C:\\Users\\me\\AppData\\Local\\gpulease\\bin";
    expect(dropPath(mergePath("C:\\a;", bin, true), bin, true)).toBe("C:\\a");
  });

  test("只装了我们的 PATH，卸完是空串（调用方把变量删掉，不写空串）", () => {
    const bin = "C:\\Users\\me\\AppData\\Local\\gpulease\\bin";
    expect(dropPath(mergePath("", bin, true), bin, true)).toBe("");
  });

  test("空的 PATH 直接放进去", () => {
    expect(mergePath("", "C:\\x", true)).toBe("C:\\x");
  });

  test("卸载时只去掉这一段，其余保持顺序", () => {
    expect(dropPath("C:\\a;C:\\x;C:\\b", "C:\\x", true)).toBe("C:\\a;C:\\b");
    expect(dropPath("C:\\a", "C:\\x", true)).toBe("C:\\a");
  });
});

describe("开机自启命令行", () => {
  test("路径带空格要加引号，参数照旧", () => {
    expect(autostartValue("C:\\Program Files\\gpulease\\gpulease.exe")).toBe(
      '"C:\\Program Files\\gpulease\\gpulease.exe" daemon --quiet',
    );
  });

  test("可以改参数", () => {
    expect(autostartValue("C:\\g.exe", ["daemon", "--interval", "5000"])).toBe('"C:\\g.exe" daemon --interval 5000');
  });
});

describe("参数解析", () => {
  test("install 认 --autostart / --no-start-menu / --dir / --json", () => {
    const o = parseInstallOptions(["install", "--autostart", "--no-start-menu", "--dir", "D:\\g", "--json"]);
    expect(o.autostart).toBe(true);
    expect(o.startMenu).toBe(false);
    expect(o.dir).toBe("D:\\g");
    expect(o.json).toBe(true);
  });

  test("默认不开自启、不跳过开始菜单", () => {
    const o = parseInstallOptions([]);
    expect(o.autostart).toBe(false);
    expect(o.startMenu).toBeUndefined();
  });

  test("uninstall 认 --purge", () => {
    expect(parseUninstallOptions(["--purge"]).purge).toBe(true);
    expect(parseUninstallOptions([]).purge).toBe(false);
  });
});
