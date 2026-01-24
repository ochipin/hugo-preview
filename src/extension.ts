import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import { execFile, spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as tar from "tar";
import AdmZip from "adm-zip";

type Platform = "windows" | "darwin" | "linux";

let previewPanel: vscode.WebviewPanel | undefined;
let hugoStatusItem: vscode.StatusBarItem;
let hugoServerProcess: ChildProcessWithoutNullStreams | null = null;
let hugoOutput: vscode.OutputChannel;
let extensionContext: vscode.ExtensionContext;
let isHugoServerRunning = false;

const localize = vscode.l10n.t;
const HUGO_SERVER_URL = "http://localhost:1313";

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;
  hugoOutput = vscode.window.createOutputChannel("Hugo Preview");
  context.subscriptions.push(hugoOutput);

  hugoStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  hugoStatusItem.tooltip = "Hugo version used by Hugo Preview";
  context.subscriptions.push(hugoStatusItem);

  prependPathOnce(context);

  ensurePinnedHugoOnStartup(context)
    .then(() => checkHugoUpdateOnStartup(context))
    .then(() => updateHugoStatus())
    .catch(() => {});

  context.subscriptions.push(
    vscode.commands.registerCommand("hugoPreview.open", async () => {
      try {
        await openPreview(context);
        // プレビュー実行後にも更新（PATH/自動DLを考慮）
        await updateHugoStatus();
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? String(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hugoPreview.installHugo", async () => {
      try {
        const hugoPath = await ensureHugo(context, true);
        vscode.window.showInformationMessage(`Hugo installed: ${hugoPath}`);
        await updateHugoStatus();
      } catch (e: any) {
        vscode.window.showErrorMessage(e?.message ?? String(e));
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("hugoPreview.showControls", async () => {
      await showHugoQuickPick(context);
    })
  );
}

export function deactivate() {}

function prependPathOnce(context: vscode.ExtensionContext) {
  const binDir = path.join(context.globalStorageUri.fsPath, "bin");
  const envCollection = context.environmentVariableCollection;
  const delimiter = process.platform === "win32" ? ";" : ":";
  envCollection.prepend('PATH', `${binDir}${delimiter}`);
}

async function openPreview(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error(localize("error.noMarkdown"));
  }

  const doc = editor.document;
  if (doc.languageId !== "markdown") {
    throw new Error(localize("error.notMarkdown"));
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    throw new Error(localize("error.noWorkspace"));
  }

  const hugo = await ensureHugo(context, false);

  // build into storage (avoid polluting repo)
  const storeRoot = context.globalStorageUri.fsPath;
  const runRoot = path.join(storeRoot, "run");
  const contentDir = path.join(runRoot, "content");
  const outDir = path.join(runRoot, "public");

  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  // =========================================================
  // mirror "content/" relative path into temp content
  // =========================================================
  const contentRoot = path.join(workspace, "content");
  const docPath = doc.uri.fsPath;

  const norm = (p: string) => path.resolve(p);

  if (
    !norm(docPath).startsWith(norm(contentRoot) + path.sep) &&
    norm(docPath) !== norm(contentRoot)
  ) {
    throw new Error(localize("error.notContent"));
  }

  // content からの相対パスをそのまま再現してコピー
  const relPath = path.relative(contentRoot, docPath);
  const dstMdPath = path.join(contentDir, relPath);

  fs.mkdirSync(path.dirname(dstMdPath), { recursive: true });
  fs.writeFileSync(dstMdPath, doc.getText(), "utf8");

  // =========================================================
  // Build (theme/config are from workspace; content is from temp)
  // =========================================================
  await execFileAsync(hugo, [
    "--source",
    workspace,
    "--contentDir",
    contentDir,
    "--destination",
    outDir,
    "--buildDrafts",
    "--buildFuture",
    "--buildExpired",
  ]);

  // =========================================================
  // ★ FIX: ask Hugo where the HTML went (supports multilingual/permalink/bundle)
  // =========================================================
  const htmlPath = await resolveHtmlPathByHugoList({
    hugo,
    workspace,
    outDir,
    contentRelPath: relPath, // "guides/install.en.md" など
  });

  if (!fs.existsSync(htmlPath)) {
    throw new Error(localize("error.htmlNotGenerated", htmlPath));
  }

  let html = fs.readFileSync(htmlPath, "utf8");

  const fileName = path.basename(relPath);

  // Webview Panel
  if (!previewPanel) {
    previewPanel = vscode.window.createWebviewPanel(
      "hugoPreview",
      fileName,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file(outDir)]
      }
    );
    previewPanel.onDidDispose(() => (previewPanel = undefined));
  } else {
    previewPanel.title = fileName; // ★ これを必ず更新
    previewPanel.reveal(vscode.ViewColumn.Beside);
  }

  // Rewrite absolute /... paths to webview local URIs
  const rootUri = previewPanel.webview.asWebviewUri(vscode.Uri.file(outDir)).toString();
  html = rewriteRootPaths(html, rootUri);

  html = html.replace(
    /<html([^>]*)>/i,
    (_m, attrs) => {
      if (/hugo-preview=/.test(attrs)) {
        return `<html${attrs}>`;
      }
      return `<html${attrs} hugo-preview="true">`;
    }
  );

  previewPanel.webview.html = html;

  // Auto refresh on save
  const disposable = vscode.workspace.onDidSaveTextDocument(async (saved) => {
    if (!previewPanel) {return;}
    if (saved.uri.fsPath !== doc.uri.fsPath) {return;}
    try {
      await openPreview(context);
    } catch {
      // ignore
    }
  });
  previewPanel.onDidDispose(() => disposable.dispose());
}

function rewriteRootPaths(html: string, rootUri: string) {
  // Replace href="/..." src="/..." with href="{rootUri}/..."
  // Good enough for many Hugo themes that use absolute paths.
  return html
    .replace(/href="\//g, `href="${rootUri}/`)
    .replace(/src="\//g, `src="${rootUri}/`)
    .replace(/action="\//g, `action="${rootUri}/`);
}

function findFirstFile(dir: string, filename: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === filename) {return p;}
    if (e.isDirectory()) {
      const found = findFirstFile(p, filename);
      if (found) {return found;}
    }
  }
  return null;
}

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `Hugo command failed.\ncmd: ${cmd} ${args.join(" ")}\n\n${stderr || stdout || err.message}`
          )
        );
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Ensure Hugo exists.
 * - If forceInstall=true: always try install (useful for command)
 * - Else: check config/path/bundled; if missing -> prompt install (if autoDownload enabled)
 */
async function ensureHugo(context: vscode.ExtensionContext, forceInstall: boolean): Promise<string> {
  const cfg = vscode.workspace.getConfiguration("hugoPreview");
  const userPath = (cfg.get<string>("hugoPath") || "").trim();
  const autoDownload = cfg.get<boolean>("autoDownload") ?? true;

  // 1) user specified
  if (userPath) {
    const ok = await checkHugo(userPath);
    if (ok) {return userPath;}
    throw new Error(localize("error.hugoInvalid", userPath));
  }

  // 2) PATH
  if (!forceInstall) {
    if (await checkHugo("hugo")) { return "hugo"; }
  }

  // 3) installed in global storage
  const binDir = path.join(context.globalStorageUri.fsPath, "bin");
  const hugoBin = path.join(binDir, getHugoBinaryName());
  if (!forceInstall && fs.existsSync(hugoBin) && (await checkHugo(hugoBin))) {
    return hugoBin;
  }

  // 4) install
  if (!autoDownload && !forceInstall) {
    throw new Error(localize("error.hugoNotFound"));
  }

  const installLabel = localize("button.install");
  const cancelLabel  = localize("button.cancel");

  const choice = await vscode.window.showInformationMessage(
    localize("info.confirmInstall"),
    installLabel,
    cancelLabel
  );

  if (choice !== installLabel) {
    throw new Error(localize("error.installCanceled"));
  }

  await installHugo(context);
  if (fs.existsSync(hugoBin) && (await checkHugo(hugoBin))) {
    return hugoBin;
  }

  throw new Error(localize("error.installFailed"));
}

async function ensurePinnedHugoOnStartup(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("hugoPreview");
  const pinned = (cfg.get<string>("hugoVersion") || "").trim();
  if (!pinned) {
    return; // ピン留めなし
  }

  const hugoPath = await resolveInstalledHugo(context);
  if (!hugoPath) {
    // 未インストール → 指定バージョンを入れる
    await installHugoInternal(
      context,
      pinned,
      cfg.get<boolean>("useExtended") ?? true
    );
    return;
  }

  const localVer = await getLocalHugoVersion(hugoPath);
  if (!localVer || localVer !== pinned) {
    // 不一致 → 再インストール
    await installHugoInternal(
      context,
      pinned,
      cfg.get<boolean>("useExtended") ?? true
    );
  }
}

function checkHugo(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(cmd, ["version"], (err) => resolve(!err));
  });
}

function getHugoBinaryName() {
  return process.platform === "win32" ? "hugo.exe" : "hugo";
}

function mapPlatform(): Platform {
  const p = process.platform;
  if (p === "win32") {return "windows";}
  if (p === "darwin") {return "darwin";}
  if (p === "linux") {return "linux";}
  throw new Error(`Unsupported platform: ${p}`);
}

function mapArch(): "amd64" | "arm64" {
  const a = process.arch;
  if (a === "x64") {return "amd64";}
  if (a === "arm64") {return "arm64";}
  // WSL2 typically x64/arm64 only; keep strict
  throw new Error(`Unsupported arch: ${a}`);
}

async function installHugo(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("hugoPreview");
  let version = (cfg.get<string>("hugoVersion") || "").trim();

  // バージョンが指定されていない場合は、最新版を取得する
  if (!version) {
    try {
      version = await getLatestHugoVersion();
    } catch (e) {
      // ネットワークエラーなどで取得できない場合の最終フォールバック
      version = "0.152.2";
      vscode.window.showWarningMessage(
        vscode.l10n.t("warn.hugoLatestVersionFailed")
      );
    }
  }

  const useExtended = cfg.get<boolean>("useExtended") ?? true;

  await installHugoInternal(context, version, useExtended);
}

async function installHugoInternal(context: vscode.ExtensionContext, version: string, useExtended: boolean) {
  const platform = mapPlatform(); // windows/darwin/linux
  const arch = mapArch();         // amd64/arm64

  const store = context.globalStorageUri.fsPath;
  const binDir = path.join(store, "bin");
  const tmpDir = path.join(store, "tmp");

  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const binPath = path.join(binDir, getHugoBinaryName());

  const isWin = platform === "windows";
  const flavor = useExtended ? "hugo_extended" : "hugo";
  const base = `https://github.com/gohugoio/hugo/releases/download/v${version}/`;

  // Hugo naming: hugo_extended_${version}_${platform}-${arch}.tar.gz  (mac/linux)
  // Windows: hugo_extended_${version}_windows-amd64.zip
  const fileName = isWin
    ? `${flavor}_${version}_${platform}-${arch}.zip`
    : `${flavor}_${version}_${platform}-${arch}.tar.gz`;

  const url = base + fileName;
  const archivePath = path.join(tmpDir, fileName);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: localize("progress.hugoDownloading", version, platform, arch),
      cancellable: false
    },
    async () => {
      await downloadFile(url, archivePath);
      // Extract to tmpDir/extract
      const extractDir = path.join(tmpDir, "extract");
      rmrf(extractDir);
      fs.mkdirSync(extractDir, { recursive: true });

      if (isWin) {
        const zip = new AdmZip(archivePath);
        zip.extractAllTo(extractDir, true);
      } else {
        await tar.x({ file: archivePath, cwd: extractDir });
      }

      // Find hugo binary inside extract dir
      const found = findHugoBinary(extractDir, isWin);
      if (!found) {
        throw new Error(localize("error.hugoBinaryNotFound", fileName));
      }

      fs.copyFileSync(found, binPath);

      if (!isWin) {
        try {
          fs.chmodSync(binPath, 0o755);
        } catch {
          // ignore
        }
      }
    }
  );

  // Final sanity check
  const ok = await checkHugo(binPath);
  if (!ok) {
    throw new Error(vscode.l10n.t("error.hugoNotExecutable"));
  }
}

function findHugoBinary(dir: string, isWin: boolean): string | null {
  const target = isWin ? "hugo.exe" : "hugo";
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === target) {return p;}
    if (e.isDirectory()) {
      const found = findHugoBinary(p, isWin);
      if (found) {return found;}
    }
  }
  return null;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { "User-Agent": "vscode-hugo-preview" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect
        file.close();
        fs.unlinkSync(dest);
        downloadFile(res.headers.location, dest).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed: HTTP ${res.statusCode} (${url})`));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    req.on("error", (err) => {
      try { file.close(); } catch {}
      try { fs.unlinkSync(dest); } catch {}
      reject(err);
    });
  });
}

function rmrf(p: string) {
  if (!fs.existsSync(p)) {return;}
  fs.rmSync(p, { recursive: true, force: true });
}

async function resolveInstalledHugo(
  context: vscode.ExtensionContext
): Promise<string | null> {
  const cfg = vscode.workspace.getConfiguration("hugoPreview");
  const userPath = (cfg.get<string>("hugoPath") || "").trim();

  // 1) 設定で指定された Hugo
  if (userPath && await checkHugo(userPath)) {
    return userPath;
  }

  // 2) PATH 上の Hugo
  if (await checkHugo("hugo")) {
    return "hugo";
  }

  // 3) 拡張が管理している Hugo
  const binDir = path.join(context.globalStorageUri.fsPath, "bin");
  const hugoBin = path.join(binDir, getHugoBinaryName());
  if (fs.existsSync(hugoBin) && await checkHugo(hugoBin)) {
    return hugoBin;
  }

  // 未インストール
  return null;
}

async function getLocalHugoVersion(hugoPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(hugoPath, ["version"], (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      // 例: hugo v0.152.2+extended
      const m = stdout.match(/v(\d+\.\d+\.\d+)/);
      resolve(m ? m[1] : null);
    });
  });
}

function getLatestHugoVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get(
      "https://api.github.com/repos/gohugoio/hugo/releases/latest",
      { headers: { "User-Agent": "vscode-hugo-preview" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.tag_name.replace(/^v/, ""));
          } catch (e) {
            reject(e);
          }
        });
      }
    ).on("error", reject);
  });
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split(".").map(Number);
  const l = local.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((r[i] ?? 0) > (l[i] ?? 0)) {return true;}
    if ((r[i] ?? 0) < (l[i] ?? 0)) {return false;}
  }
  return false;
}

async function checkHugoUpdateOnStartup(context: vscode.ExtensionContext) {
  const cfg = vscode.workspace.getConfiguration("hugoPreview");
  const pinnedVersion = (cfg.get<string>("hugoVersion") || "").trim();
  if (pinnedVersion) {
    console.log(`Hugo version is pinned to ${pinnedVersion}. Skipping update check.`);
    return;
  }
  const hugoPath = await resolveInstalledHugo(context);

  // Hugo 未インストールなら何もしない
  if (!hugoPath) {return;}

  const localVer = await getLocalHugoVersion(hugoPath);
  if (!localVer) {return;}

  const latestVer = await getLatestHugoVersion();
  if (!isNewer(latestVer, localVer)) {return;}

  const updateLabel = localize("button.update");
  const laterLabel  = localize("button.later");

  const choice = await vscode.window.showInformationMessage(
    localize("info.hugoUpdateAvailable", latestVer, localVer),
    updateLabel,
    laterLabel
  );

  if (choice !== updateLabel) {return;}

  await installHugoInternal(
    context,
    latestVer,
    cfg.get<boolean>("useExtended") ?? true
  );

  vscode.window.showInformationMessage(localize("info.hugoUpdated", latestVer));

  await updateHugoStatus();
}

async function updateHugoStatus() {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspace || !isHugoProject(workspace)) {
    hugoStatusItem.hide();
    return;
  }

  const hugoPath = await resolveInstalledHugo(extensionContext);

  if (!hugoPath) {
    hugoStatusItem.text = `$(warning) Hugo Install Needed`;
    hugoStatusItem.command = "hugoPreview.installHugo";
    hugoStatusItem.show();
    return;
  }

  const ver = await getLocalHugoVersion(hugoPath);
  const versionText = ver || "Detected";

  // ★ サーバ状態は「見るだけ」
  hugoStatusItem.text = isHugoServerRunning
    ? `$(sync~spin) Hugo ${versionText}`
    : `$(rocket) Hugo ${versionText}`;

  hugoStatusItem.command = "hugoPreview.showControls";
  hugoStatusItem.show();
}


async function showHugoQuickPick(context: vscode.ExtensionContext) {
  type Action = "start" | "stop" | "restart" | "open";

  const items: (vscode.QuickPickItem & { action: Action })[] = [
    {
      label: "$(play) " + localize("quick.start"),
      description: "hugo server",
      action: "start",
    },
    {
      label: "$(debug-stop) " + localize("quick.stop"),
      description: localize("quick.stop.desc"),
      action: "stop",
    },
    {
      label: "$(sync) " + localize("quick.restart"),
      description: localize("quick.restart.desc"),
      action: "restart",
    },
    {
      label: "$(globe) " + localize("quick.open"),
      description: HUGO_SERVER_URL,
      action: "open",
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: localize("quick.title"),
    placeHolder: localize("quick.placeholder"),
  });

  if (!selected) {
    return;
  }

  switch (selected.action) {
    case "start":
      await startHugoServer(context);
      break;

    case "stop":
      await stopHugoServer();
      break;

    case "restart":
      await restartHugoServer(context);
      break;

    case "open":
      vscode.env.openExternal(vscode.Uri.parse(HUGO_SERVER_URL));
      break;
  }
}


function cleanPublicDir(outDir: string) {
  if (!fs.existsSync(outDir)) {
    return;
  }

  for (const entry of fs.readdirSync(outDir)) {
    const fullPath = path.join(outDir, entry);
    fs.rmSync(fullPath, { recursive: true, force: true });
  }
}

async function startHugoServer(context: vscode.ExtensionContext) {
  if (hugoServerProcess) {
    vscode.window.showInformationMessage(localize("error.hugoStartServer"));
    return;
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    vscode.window.showErrorMessage(localize("error.noWorkspace"));
    return;
  }

  const hugo = await ensureHugo(context, false);

  // public を掃除
  const outDir = path.join(workspace, "public");
  try {
    cleanPublicDir(outDir);
    hugoOutput.appendLine("[Hugo Preview] Cleaned public directory.");
  } catch (e: any) {
    vscode.window.showErrorMessage(
      localize("error.cleanPublicFailed", e?.message ?? String(e))
    );
    return;
  }

  let logBuf = "";
  let started = false;
  let hasErrorLine = false;

  hugoOutput.clear();
  hugoOutput.appendLine(`[Hugo Preview] Starting hugo server...`);
  hugoOutput.appendLine(`Command: ${hugo} server -D`);
  hugoOutput.appendLine(`Workspace: ${workspace}`);
  hugoOutput.appendLine("");

  const onLog = (chunk: Buffer) => {
    const msg = chunk.toString();
    logBuf += msg;

    hugoOutput.append(msg);

    if (
      /^ERROR\b/m.test(msg) ||
      /error building site/i.test(msg) ||
      /failed to create page/i.test(msg)
    ) {
      hasErrorLine = true;
    }

    if (!started && /Web Server is available/i.test(msg)) {
      started = true;
      isHugoServerRunning = true;
      updateHugoStatus();
      vscode.window.showInformationMessage(
        localize("info.hugoStartServer")
      );
    }
  };

  try {
    hugoServerProcess = spawn(
      hugo,
      ["server", "-D"],
      { cwd: workspace, stdio: "pipe" }
    );
  } catch (e: any) {
    vscode.window.showErrorMessage(
      localize(
        "error.hugoStartServerFailed",
        e?.message ?? String(e)
      )
    );
    hugoServerProcess = null;
    return;
  }

  hugoServerProcess.stdout.on("data", onLog);
  hugoServerProcess.stderr.on("data", onLog);

  hugoServerProcess.on("error", (err) => {
    hugoServerProcess = null;
    hugoOutput.appendLine(`\n[process error] ${err.message}`);
    hugoOutput.show(true);

    vscode.window.showErrorMessage(
      localize("error.hugoServerLaunchFailed")
    );
  });

  hugoServerProcess.on("exit", (code, signal) => {
    hugoServerProcess = null;
    isHugoServerRunning = false;
    updateHugoStatus();
    if ((code ?? 0) !== 0 || hasErrorLine) {
      hugoOutput.appendLine("");
      hugoOutput.appendLine(
        `[Hugo Preview] Server exited with error (code=${code ?? "unknown"}${signal ? `, signal=${signal}` : ""})`
      );
      hugoOutput.show(true);

      const m = logBuf.match(/content\/.+\.md:\d+:\d+:[^\n]+/);
      const summary = m ? m[0] : localize("error.seeOutput");

      vscode.window.showErrorMessage(
        localize("error.hugoServerFailed", summary)
      );
      return;
    }

    if (!started) {
      hugoOutput.appendLine("");
      hugoOutput.appendLine(
        `[Hugo Preview] Server exited unexpectedly (code=${code ?? "unknown"})`
      );
      hugoOutput.show(true);

      vscode.window.showErrorMessage(
        localize("error.hugoServerExitedUnexpectedly")
      );
    }
  });
}

function stopHugoServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!hugoServerProcess) {
      vscode.window.showInformationMessage(
        localize("error.hugoStopServer")
      );
      resolve();
      return;
    }

    const proc = hugoServerProcess;
    hugoServerProcess = null;

    proc.once("exit", () => {
      isHugoServerRunning = false;
      updateHugoStatus();
      vscode.window.showInformationMessage(
        localize("info.hugoStopServer")
      );
      resolve();
    });

    proc.kill();
  });
}

async function restartHugoServer(context: vscode.ExtensionContext) {
  await stopHugoServer();
  await startHugoServer(context);
}

function isHugoProject(workspace: string): boolean {
  const files = [
    "config.toml",
    "config.yaml",
    "config.yml",
    "hugo.toml",
  ];
  return files.some(f => fs.existsSync(path.join(workspace, f)));
}

async function resolveHtmlPathByHugoList(opts: {
  hugo: string;
  workspace: string;
  outDir: string;
  contentRelPath: string; // 例: guides/install.en.md
}): Promise<string> {
  const { hugo, workspace, outDir, contentRelPath } = opts;

  // ① hugo list all（CSV出力）
  const { stdout } = await execFileAsync(hugo, [
    "--source",
    workspace,
    "list",
    "all",
  ]);

  const lines = stdout.trim().split("\n");
  if (lines.length < 2) {
    throw new Error(localize("error.hugoListEmpty"));
  }

  // ② ヘッダ解析
  const headers = lines[0].split(",");
  const idxPath = headers.indexOf("path");
  const idxPermalink = headers.indexOf("permalink");

  if (idxPath === -1 || idxPermalink === -1) {
    throw new Error(localize("error.hugoListInvalidFormat"));
  }

  const normalize = (p: string) => p.replace(/\\/g, "/");

  const targetPath = normalize(`content/${contentRelPath}`);

  // ③ 対象 Markdown を探す
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");

    if (normalize(cols[idxPath]) !== targetPath) {
      continue;
    }

    const permalink = cols[idxPermalink];
    if (!permalink) {
      throw new Error(localize("error.hugoPermalinkMissing", contentRelPath));
    }

    // ④ permalink → public 配下の HTML
    const url = new URL(permalink);

    const htmlRelPath = path.join(
      url.pathname.replace(/^\/+/, ""),
      "index.html"
    );

    return path.join(outDir, htmlRelPath);
  }

  throw new Error(localize("error.htmlNotGenerated", contentRelPath));
}
