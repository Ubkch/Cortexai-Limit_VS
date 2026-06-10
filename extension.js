const vscode = require("vscode");
const https = require("https");

const REFRESH_MS = 30 * 1000;

const PROVIDERS = {
  "claude.gg":        "https://claude.gg/api/me?key=",
  "vertex.claude.gg": "https://vertex.claude.gg/api/me?key=",
};

let statusBar;
let timer;

function getCfg() {
  return vscode.workspace.getConfiguration("claudeApiLimits");
}
function getApiKey()  { return getCfg().get("apiKey", ""); }
function getProvider(){ return getCfg().get("provider", "claude.gg"); }

function extractKey(input) {
  if (!input) return "";
  const match = input.match(/[?&]key=(sk-[a-zA-Z0-9]+)/);
  if (match) return match[1];
  if (input.trim().startsWith("sk-")) return input.trim();
  return "";
}

// Provider'ı URL'den otomatik tespit et
function detectProvider(input) {
  if (!input) return null;
  for (const [name, base] of Object.entries(PROVIDERS)) {
    if (input.includes(new URL(base).hostname)) return name;
  }
  return null;
}

async function promptForKey() {
  const provider = getProvider();
  const input = await vscode.window.showInputBox({
    title: `API Key — ${provider}`,
    prompt: "Tam URL ya da sk-... key yapıştır",
    placeHolder: `https://${provider}/api/me?key=sk-...  ya da  sk-...`,
    ignoreFocusOut: true,
    validateInput: (v) => extractKey(v) ? null : "Geçerli bir URL ya da sk- key girin",
  });
  if (!input) return false;
  const key = extractKey(input);
  const detected = detectProvider(input);
  const cfg = getCfg();
  await cfg.update("apiKey", key, vscode.ConfigurationTarget.Global);
  if (detected && detected !== getProvider()) {
    await cfg.update("provider", detected, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Provider otomatik seçildi: ${detected}`);
  }
  return true;
}

async function promptForProvider() {
  const current = getProvider();
  const items = Object.keys(PROVIDERS).map((p) => ({
    label: p,
    description: PROVIDERS[p] + "sk-...",
    picked: p === current,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "API Provider Seç",
    placeHolder: "Hangi servisi kullanıyorsun?",
  });
  if (!picked) return;
  await getCfg().update("provider", picked.label, vscode.ConfigurationTarget.Global);
  // Key farklı provider için de geçerliyse doğrudan yenile, yoksa tekrar sor
  statusBar.text = "$(sync~spin) claude.gg";
  refresh();
}

function fetchLimits() {
  const key = getApiKey();
  const provider = getProvider();
  if (!key) return Promise.reject(new Error("NO_KEY"));
  const base = PROVIDERS[provider] || PROVIDERS["claude.gg"];
  const url = base + key;
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function pct(used, limit) {
  return limit > 0 ? Math.round((used / limit) * 100) : 0;
}

function timeUntil(isoString) {
  const diff = new Date(isoString) - Date.now();
  if (diff <= 0) return "yakında";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  if (h > 0) return `${h}s ${m}dk`;
  if (m > 0) return `${m}dk ${s}sn`;
  return `${s}sn`;
}

async function refresh() {
  try {
    const json = await fetchLimits();
    const d = json.data.rate_limit;
    const h = d.hourly;
    const dp = pct(d.used, d.limit);
    const hp = pct(h.used, h.limit);
    const icon = dp >= 80 || hp >= 80 ? "$(warning)" : "$(pass)";
    const provider = getProvider();

    statusBar.text = `${icon} ${d.remaining.toLocaleString()}/${d.limit} · ${h.remaining}/${h.limit}hr`;
    statusBar.backgroundColor =
      dp >= 80 || hp >= 80
        ? new vscode.ThemeColor("statusBarItem.warningBackground")
        : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${provider} API Limitleri**\n\n---\n\n`);
    md.appendMarkdown(`**Günlük**\n`);
    md.appendMarkdown(`- Kalan: \`${d.remaining.toLocaleString()}\` / \`${d.limit.toLocaleString()}\` · %${dp}\n`);
    md.appendMarkdown(`- Sıfırlanma: **${timeUntil(d.reset_time)}** içinde\n\n`);
    md.appendMarkdown(`**Saatlik**\n`);
    md.appendMarkdown(`- Kalan: \`${h.remaining}\` / \`${h.limit}\` · %${hp}\n`);
    md.appendMarkdown(`- Sıfırlanma: **${timeUntil(h.reset_time)}** içinde\n\n---\n\n`);
    md.appendMarkdown(`_Tıkla: yenile · 30sn oto · Provider: ${provider}_`);
    statusBar.tooltip = md;
  } catch (e) {
    if (e.message === "NO_KEY") {
      statusBar.text = "$(key) claude — kur";
      statusBar.tooltip = "Tıkla: API key gir";
      statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      statusBar.text = "$(circle-slash) claude";
      statusBar.tooltip = `Hata: ${e.message}`;
      statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
  }
}

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  statusBar.command = "claudeApiLimits.refresh";
  statusBar.text = "$(sync~spin) claude";
  statusBar.show();

  const refreshCmd = vscode.commands.registerCommand("claudeApiLimits.refresh", async () => {
    if (!getApiKey()) { await promptForKey(); }
    statusBar.text = "$(sync~spin) claude";
    refresh();
  });

  const setKeyCmd = vscode.commands.registerCommand("claudeApiLimits.setApiKey", async () => {
    await promptForKey();
    statusBar.text = "$(sync~spin) claude";
    refresh();
  });

  const providerCmd = vscode.commands.registerCommand("claudeApiLimits.selectProvider", promptForProvider);

  const cfgChange = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("claudeApiLimits")) {
      statusBar.text = "$(sync~spin) claude";
      refresh();
    }
  });

  context.subscriptions.push(statusBar, refreshCmd, setKeyCmd, providerCmd, cfgChange);

  if (!getApiKey()) {
    statusBar.text = "$(key) claude — kur";
    statusBar.tooltip = "Tıkla: API key gir";
    statusBar.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    setTimeout(async () => {
      // Önce provider sor, sonra key
      await promptForProvider();
      await promptForKey();
      statusBar.text = "$(sync~spin) claude";
      refresh();
    }, 1000);
  } else {
    refresh();
  }

  timer = setInterval(refresh, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
}

function deactivate() { clearInterval(timer); }

module.exports = { activate, deactivate };
module.exports = { activate, deactivate };


