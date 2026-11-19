const { app, BrowserWindow, dialog, ipcMain, protocol, session, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fs = require("node:fs/promises");
const path = require("node:path");

const APP_SCHEME = "jkbms";
const APP_HOST = "app";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const RELEASES_URL = "https://github.com/vcpstudio/jkbms/releases/latest";
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'";
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);
const ALLOWED_APP_FILES = new Set([
  "index.html",
  "styles.css",
  "app.mjs",
  "app-utils.mjs",
  "protocol.mjs",
  "discharge-forecast.mjs",
  "flow-periods.mjs",
  "voltage-chart-data.mjs",
  "electron/bluetooth-picker.html",
  "electron/bluetooth-picker.css",
  "electron/bluetooth-picker.js",
]);

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

let mainWindow;
let pickerWindow;
let bluetoothSelectionCallback;
let bluetoothDevices = [];
let lastSelectedBluetoothDevice;
let pickerReady = false;
let updateStatus = { state: "idle" };
let startupUpdateTimer;
let startupUpdateChecked = false;

app.whenReady()
  .then(() => {
    protocol.handle(APP_SCHEME, serveAppFile);
    configureAutoUpdater();
    configureBluetoothPermissions();
    configureBluetoothPicker();
    createMainWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  })
  .catch((error) => {
    console.error("Не вдалося запустити JK BMS Monitor:", error);
    dialog.showErrorBox("Не вдалося запустити JK BMS Monitor", error.message);
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

async function serveAppFile(request) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return new Response("Некоректна адреса.", { status: 400 });
  }

  if (url.hostname !== APP_HOST) return new Response("Не знайдено.", { status: 404 });
  if (request.method !== "GET") return new Response("Метод не підтримується.", { status: 405 });

  let relativePath;
  try {
    relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
  } catch {
    return new Response("Некоректний шлях.", { status: 400 });
  }

  const appPath = app.getAppPath();
  const filePath = path.resolve(appPath, relativePath);
  const pathFromApp = path.relative(appPath, filePath);
  const normalizedRelativePath = pathFromApp.split(path.sep).join("/");
  if (
    !pathFromApp ||
    pathFromApp === ".." ||
    pathFromApp.startsWith(`..${path.sep}`) ||
    path.isAbsolute(pathFromApp) ||
    !ALLOWED_APP_FILES.has(normalizedRelativePath)
  ) {
    return new Response("Заборонено.", { status: 403 });
  }

  let content;
  try {
    content = await fs.readFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EISDIR") {
      return new Response("Не знайдено.", { status: 404 });
    }
    console.error(`Не вдалося прочитати файл застосунку: ${filePath}`, error);
    return new Response("Помилка читання файлу застосунку.", { status: 500 });
  }

  return new Response(content, {
    headers: {
      "Content-Type": MIME_TYPES.get(path.extname(filePath)) ?? "application/octet-stream",
      "Content-Security-Policy": CONTENT_SECURITY_POLICY,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function configureBluetoothPermissions() {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    return permission === "bluetooth" && isAppOrigin(requestingOrigin);
  });

  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const requestingUrl = details?.requestingUrl || webContents?.getURL() || "";
      callback(permission === "bluetooth" && isAppOrigin(requestingUrl));
    },
  );
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on("checking-for-update", () => {
    publishUpdateStatus({ state: "checking" });
  });
  autoUpdater.on("update-available", (info) => {
    publishUpdateStatus({
      state: process.platform === "darwin" ? "manual" : "available",
      version: info.version,
    });
  });
  autoUpdater.on("update-not-available", (info) => {
    publishUpdateStatus({ state: "current", version: info.version });
  });
  autoUpdater.on("download-progress", ({ percent }) => {
    publishUpdateStatus({
      state: "downloading",
      percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateStatus({ state: "downloaded", version: info.version });
  });
  autoUpdater.on("error", publishUpdateError);

  ipcMain.handle("app-update:check", (event) => {
    assertMainWindowSender(event);
    return checkForUpdates();
  });
  ipcMain.handle("app-update:download", async (event) => {
    assertMainWindowSender(event);
    if (updateStatus.state !== "available") {
      throw new Error("Немає доступного для завантаження оновлення.");
    }
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      if (updateStatus.state !== "error") publishUpdateError(error);
      throw error;
    }
  });
  ipcMain.handle("app-update:install", (event) => {
    assertMainWindowSender(event);
    if (updateStatus.state !== "downloaded") {
      throw new Error("Оновлення ще не завантажено.");
    }
    autoUpdater.quitAndInstall();
  });
  ipcMain.handle("app-update:open-release", async (event) => {
    assertMainWindowSender(event);
    await shell.openExternal(RELEASES_URL);
  });
}

function assertMainWindowSender(event) {
  if (event.sender !== mainWindow?.webContents) {
    throw new Error("Запит оновлення надійшов не з головного вікна.");
  }
}

function checkForUpdates() {
  if (!app.isPackaged) {
    publishUpdateStatus({
      state: "error",
      message: "Перевірка оновлень доступна лише в установленій desktop-версії.",
    });
    return Promise.resolve();
  }

  return autoUpdater.checkForUpdates().catch((error) => {
    if (updateStatus.state !== "error") publishUpdateError(error);
  });
}

function publishUpdateError(error) {
  console.error("Не вдалося перевірити або встановити оновлення:", error);
  publishUpdateStatus({
    state: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

function publishUpdateStatus(status) {
  updateStatus = status;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app-update:status", status);
  }
}

function configureBluetoothPicker() {
  ipcMain.handle("bluetooth-picker:consume-selected", (event) => {
    assertMainWindowSender(event);
    const selected = lastSelectedBluetoothDevice;
    lastSelectedBluetoothDevice = undefined;
    return selected ?? null;
  });

  ipcMain.on("bluetooth-picker:choose", (event, deviceId) => {
    const chosenDevice = bluetoothDevices.find((device) => device.deviceId === deviceId);
    if (
      event.sender !== pickerWindow?.webContents ||
      typeof deviceId !== "string" ||
      !chosenDevice
    ) {
      return;
    }
    lastSelectedBluetoothDevice = {
      id: chosenDevice.deviceId,
      name: chosenDevice.deviceName || "",
    };
    finishBluetoothSelection(deviceId);
  });

  ipcMain.on("bluetooth-picker:cancel", (event) => {
    if (event.sender === pickerWindow?.webContents) {
      lastSelectedBluetoothDevice = undefined;
      finishBluetoothSelection("");
    }
  });
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 760,
    minHeight: 620,
    show: false,
    backgroundColor: "#111512",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on("select-bluetooth-device", (event, deviceList, callback) => {
    event.preventDefault();
    bluetoothSelectionCallback = callback;
    bluetoothDevices = deviceList.map(({ deviceId, deviceName }) => ({ deviceId, deviceName }));
    showBluetoothPicker();
    publishBluetoothDevices();
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url)) event.preventDefault();
  });
  mainWindow.webContents.on("did-finish-load", () => {
    publishUpdateStatus(updateStatus);
    if (app.isPackaged && !startupUpdateChecked && updateStatus.state === "idle") {
      startupUpdateChecked = true;
      clearTimeout(startupUpdateTimer);
      startupUpdateTimer = setTimeout(() => {
        startupUpdateTimer = undefined;
        if (updateStatus.state === "idle") void checkForUpdates();
      }, 5000);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    clearTimeout(startupUpdateTimer);
    startupUpdateTimer = undefined;
    if (bluetoothSelectionCallback) finishBluetoothSelection("");
    mainWindow = undefined;
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`).catch((error) => {
    console.error("Не вдалося відкрити вікно JK BMS Monitor:", error);
    dialog.showErrorBox("Не вдалося відкрити застосунок", error.message);
    app.quit();
  });
}

function showBluetoothPicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    return;
  }

  pickerReady = false;
  pickerWindow = new BrowserWindow({
    width: 440,
    height: 620,
    minWidth: 360,
    minHeight: 400,
    parent: mainWindow,
    modal: true,
    resizable: true,
    show: false,
    title: "Вибір Bluetooth-пристрою",
    backgroundColor: "#111512",
    webPreferences: {
      preload: path.join(__dirname, "bluetooth-picker-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  pickerWindow.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url)) event.preventDefault();
  });
  pickerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  pickerWindow.webContents.on("did-finish-load", () => {
    pickerReady = true;
    publishBluetoothDevices();
  });
  pickerWindow.on("closed", () => {
    pickerWindow = undefined;
    pickerReady = false;
    if (bluetoothSelectionCallback) finishBluetoothSelection("");
  });
  pickerWindow.once("ready-to-show", () => pickerWindow?.show());
  pickerWindow.loadURL(`${APP_ORIGIN}/electron/bluetooth-picker.html`).catch((error) => {
    console.error("Не вдалося відкрити вибір Bluetooth-пристрою:", error);
    dialog.showErrorBox("Не вдалося відкрити вибір Bluetooth-пристрою", error.message);
    finishBluetoothSelection("");
  });
}

function publishBluetoothDevices() {
  if (pickerReady && pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.webContents.send("bluetooth-picker:devices", bluetoothDevices);
  }
}

function finishBluetoothSelection(deviceId) {
  const callback = bluetoothSelectionCallback;
  bluetoothSelectionCallback = undefined;
  bluetoothDevices = [];
  if (callback) callback(deviceId);
  if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
}

function isAppOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST;
  } catch {
    return false;
  }
}
