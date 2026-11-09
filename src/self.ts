// 重新起一个自己。编译成 exe 后 process.execPath 就是 exe；开发时是 bun + 脚本路径。
// 两件事必须一致：同一个 GPULEASE_HOME、同一套参数，否则 daemon 起的任务不在同一本账上。

export function selfCommand(args: string[]): string[] {
  const exe = process.execPath;
  const isBun = /(^|[\\/])bun(\.exe)?$/i.test(exe);
  const script = process.argv[1];
  if (isBun && script && !/bun(\.exe)?$/i.test(script)) return [exe, script, ...args];
  return [exe, ...args];
}
