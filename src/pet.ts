import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { loadEnvFile } from "node:process";
import { loadConfig, type Config } from "./config.js";
import { ensureDaemon } from "./daemon.js";
import { VERSION } from "./version.js";
import { errorText } from "./util.js";

const execute = promisify(execFile);
const desktop = fileURLToPath(new URL("../desktop/", import.meta.url));

/** The shell contains presentation only; Pi remains in the existing local daemon. */
export async function buildPet(dataDir: string) {
  if (process.platform !== "darwin") throw new Error("桌面小伙伴首版支持 macOS 13 及以上；其他平台可继续使用 npm run chat。");
  const app = join(dataDir, "desktop", "Local Pi Pet.app");
  const contents = join(app, "Contents"), executable = join(contents, "MacOS", "LocalPiPet");
  const sources = ["PetCore.swift", "PetAppearance.swift", "PetInput.swift", "PetApp.swift"].map(name => join(desktop, name));
  const identity = `local.piharness.pet.${createHash("sha256").update(resolve(dataDir)).digest("hex").slice(0, 12)}`;
  await mkdir(dirname(executable), { recursive: true, mode: 0o700 });
  const signature = createHash("sha256").update(VERSION);
  for (const source of sources) signature.update(await readFile(source));
  const fingerprint = signature.digest("hex"), stamp = join(dataDir, "desktop", "build.sha256");
  const previous = await readFile(stamp, "utf8").catch(() => "");
  if (previous !== fingerprint || !await stat(executable).catch(() => undefined)) {
    console.log("正在构建原生桌面小伙伴（首次启动需要 Swift 命令行工具）…");
    await execute("xcrun", ["swiftc", "-O", "-parse-as-library", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx13.0`,
      "-module-cache-path", join(dataDir, "desktop", "module-cache"), ...sources, "-framework", "AppKit", "-framework", "SwiftUI", "-o", executable], { maxBuffer: 2_000_000 });
    await writeFile(stamp, fingerprint, { mode: 0o600 });
  }
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>LocalPiPet</string>
<key>CFBundleIdentifier</key><string>${identity}</string>
<key>CFBundleName</key><string>Kada</string>
<key>CFBundleDisplayName</key><string>Kada</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundleVersion</key><string>${VERSION}</string>
<key>LSMinimumSystemVersion</key><string>13.0</string>
<key>LSUIElement</key><true/><key>NSHighResolutionCapable</key><true/>
</dict></plist>`;
  await writeFile(join(contents, "Info.plist"), plist, { mode: 0o600 });
  return { app, executable, identity };
}

export async function launchPet(config: Config, configFile?: string) {
  const built = await buildPet(config.dataDir);
  // This entry point does not opt into a computer-use driver.
  if (config.computer) throw new Error("桌面入口当前只连接终端任务，请先关闭 computer 配置；不会安装或启动电脑驱动。");
  await ensureDaemon(config, configFile);
  // A standalone macOS app should not read project files just to connect to localhost.
  const support = join(homedir(), "Library", "Application Support", "Local Pi Pet", built.identity);
  await mkdir(support, { recursive: true, mode: 0o700 });
  const configuration = join(support, "connection.json");
  const apiToken = (await readFile(join(config.dataDir, "token"), "utf8")).trim();
  await writeFile(configuration, JSON.stringify({ dataDir: config.dataDir, port: config.port, version: VERSION, apiToken }), { mode: 0o600 });
  await execute("open", ["-a", built.app, "--args", "--configuration", configuration]);
  console.log("桌面小伙伴已打开。点击伙伴下达目标；拖动可换位置，右键可修改名字、换造型或退出。退出后，已确认任务仍在后台执行。");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    try { loadEnvFile(".env"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const args = parseArgs({ options: { config: { type: "string" }, build: { type: "boolean" } } });
    const config = await loadConfig(args.values.config);
    if (args.values.build) console.log((await buildPet(config.dataDir)).app);
    else await launchPet(config, args.values.config);
  } catch (error) { console.error(errorText(error)); process.exitCode = 1; }
}
