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

const HUGO_SERVER_URL = "http://localhost:1313";

export function activate(context: vscode.ExtensionContext) {
  hugoStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  hugoStatusItem.tooltip = "Hugo version used by Hugo Preview";
  context.subscriptions.push(hugoStatusItem);

  // 起動時に表示更新
  // 起動時に現在のフォルダがHugoプロジェクトかチェックして表示更新
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (workspace && isHugoProject(workspace)) {
      updateHugoStatus(context).catch(() => {});
      checkHugoUpdateOnStartup(context).catch(() => {});
    }

  context.subscriptions.push(
    vscode.commands.registerCommand("hugoPreview.open", async () => {
      try {
        await openPreview(context);
        // プレビュー実行後にも更新（PATH/自動DLを考慮）
        await updateHugoStatus(context);
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
        await updateHugoStatus(context);
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

  // 起動時更新チェック（既存）
  checkHugoUpdateOnStartup(context)
    .then(() => updateHugoStatus(context))
    .catch(() => {});
}

export function deactivate() {}

async function openPreview(context: vscode.ExtensionContext) {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    throw new Error("Markdown を開いてから実行して。");
  }

  const doc = editor.document;
  if (doc.languageId !== "markdown") {
    throw new Error("Markdown ファイルで実行して。");
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    throw new Error("ワークスペースを開いてから実行して。");
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
  // ★ BEST FIX: mirror "content/" relative path into temp content
  // =========================================================
  const contentRoot = path.join(workspace, "content");
  const docPath = doc.uri.fsPath;

  const norm = (p: string) => path.resolve(p);

  if (!norm(docPath).startsWith(norm(contentRoot) + path.sep) && norm(docPath) !== norm(contentRoot)) {
    throw new Error("content/ ディレクトリ配下の Markdown を開いてください。");
  }

  // content からの相対パスをそのまま再現してコピー
  const relPath = path.relative(contentRoot, docPath);
  const dstMdPath = path.join(contentDir, relPath);

  fs.mkdirSync(path.dirname(dstMdPath), { recursive: true });
  fs.writeFileSync(dstMdPath, doc.getText(), "utf8");

  // Build command:
  // - use repo as --source so theme/config are used
  // - override contentDir to our temp content
  // - output to our temp public
  await execFileAsync(hugo, [
    "--source",
    workspace,
    "--contentDir",
    contentDir,
    "--destination",
    outDir
  ]);

  // =========================================================
  // ★ BEST FIX: deterministically locate the HTML for the opened md
  // =========================================================
  const slug = path.basename(relPath, ".md");
  const sectionDir = path.dirname(relPath);

  // Hugo's default: <section>/<slug>/index.html
  // (Note: branch bundles "name/index.md" are not handled here; add later if needed)
  const htmlPath = path.join(outDir, sectionDir, slug, "index.html");

  if (!fs.existsSync(htmlPath)) {
    // (optional) extra hint for debugging
    throw new Error(
      `HTML が生成されなかった。\n` +
      `期待パス: ${htmlPath}\n` +
      `※ permalink / _index.md / bundle 構成を確認して。`
    );
  }

  let html = fs.readFileSync(htmlPath, "utf8");

  // Webview panel
  if (!previewPanel) {
    const fileName = path.basename(relPath);
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

  // Auto refresh on save (optional / minimal)
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

function execFileAsync(cmd: string, args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) {
        reject(
          new Error(
            `Hugo build failed.\ncmd: ${cmd} ${args.join(" ")}\n\n${stderr || stdout || err.message}`
          )
        );
        return;
      }
      resolve();
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
    throw new Error(`hugoPreview.hugoPath が無効: ${userPath}`);
  }

  // 2) PATH
  if (!forceInstall) {
    if (await checkHugo("hugo")) {return "hugo";}
  }

  // 3) installed in global storage
  const binDir = path.join(context.globalStorageUri.fsPath, "bin");
  const hugoBin = path.join(binDir, getHugoBinaryName());
  if (!forceInstall && fs.existsSync(hugoBin) && (await checkHugo(hugoBin))) {
    return hugoBin;
  }

  // 4) install
  if (!autoDownload && !forceInstall) {
    throw new Error("Hugo が見つからない。設定で hugoPath を指定するか autoDownload を有効にして。");
  }

  const choice = await vscode.window.showInformationMessage(
    "Hugo が見つかりません。拡張が自動でインストールしますか？",
    "インストール",
    "キャンセル"
  );
  if (choice !== "インストール") {throw new Error("キャンセルした。");}

  await installHugo(context);
  if (fs.existsSync(hugoBin) && (await checkHugo(hugoBin))) {return hugoBin;}

  throw new Error("Hugo のインストールに失敗した。ログを確認して。");
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
      vscode.window.showWarningMessage("最新バージョンの取得に失敗したため、デフォルトバージョンをインストールします。");
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
      title: `Downloading Hugo v${version} (${platform}-${arch})`,
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
        throw new Error(`アーカイブ内に Hugo 実行ファイルが見つからない: ${fileName}`);
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
    throw new Error("インストールした Hugo が実行できない。");
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

  const choice = await vscode.window.showInformationMessage(
    `Hugo ${latestVer} が利用可能です（現在: ${localVer}）。更新しますか？`,
    "更新する",
    "後で"
  );

  if (choice !== "更新する") {return;}

  await installHugoInternal(
    context,
    latestVer,
    cfg.get<boolean>("useExtended") ?? true
  );

  vscode.window.showInformationMessage(`Hugo を ${latestVer} に更新しました。`);

  await updateHugoStatus(context);
}

async function updateHugoStatus(context: vscode.ExtensionContext) {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  // 1) そもそもHugoプロジェクトでないなら隠して終了
  if (!workspace || !isHugoProject(workspace)) {
    hugoStatusItem.hide();
    return;
  }

  // 2) Hugo本体を探す
  const hugoPath = await resolveInstalledHugo(context);

  if (!hugoPath) {
    // Hugoプロジェクトなのに本体がない場合：警告アイコンを表示
    hugoStatusItem.text = `$(warning) Hugo Install Needed`;
    hugoStatusItem.command = "hugoPreview.installHugo";
    hugoStatusItem.show();
    return;
  }

  // 3) Hugoがある場合：バージョンを表示
  const ver = await getLocalHugoVersion(hugoPath);
  hugoStatusItem.text = `$(rocket) Hugo ${ver || "Detected"}`;
  hugoStatusItem.command = "hugoPreview.showControls";
  hugoStatusItem.show();
}

async function showHugoQuickPick(context: vscode.ExtensionContext) {
  const items: vscode.QuickPickItem[] = [
    {
      label: "$(play) Start Hugo server",
      description: "hugo server",
    },
    {
      label: "$(debug-stop) Stop Hugo server",
      description: "stop running server",
    },
    {
      label: "$(globe) Open site",
      description: HUGO_SERVER_URL,
    },
  ];

  const selected = await vscode.window.showQuickPick(items, {
    title: "Hugo Preview controls",
    placeHolder: "Select action",
  });

  if (!selected) {return;}

  switch (selected.label) {
    case "$(play) Start Hugo server":
      await startHugoServer(context);
      break;

    case "$(debug-stop) Stop Hugo server":
      stopHugoServer();
      break;

    case "$(globe) Open site":
      vscode.env.openExternal(vscode.Uri.parse(HUGO_SERVER_URL));
      break;
  }
}

async function startHugoServer(context: vscode.ExtensionContext) {
  if (hugoServerProcess) {
    vscode.window.showInformationMessage("Hugo server is already running.");
    return;
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspace) {
    vscode.window.showErrorMessage("Workspace not found.");
    return;
  }

  const hugo = await ensureHugo(context, false);

  hugoServerProcess = spawn(
    hugo,
    ["server", "-D"],
    {
      cwd: workspace,
      stdio: "pipe",
    }
  );

  hugoServerProcess.stdout.on("data", (d) => {
    console.log(`[hugo] ${d}`);
  });

  hugoServerProcess.stderr.on("data", (d) => {
    console.error(`[hugo] ${d}`);
  });

  hugoServerProcess.on("exit", () => {
    hugoServerProcess = null;
  });

  vscode.window.showInformationMessage("Hugo server started.");
}

function stopHugoServer() {
  if (!hugoServerProcess) {
    vscode.window.showInformationMessage("Hugo server is not running.");
    return;
  }

  hugoServerProcess.kill();
  hugoServerProcess = null;

  vscode.window.showInformationMessage("Hugo server stopped.");
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
