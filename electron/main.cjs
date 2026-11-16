const { app, BrowserWindow, dialog, ipcMain, protocol, session } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");

const APP_SCHEME = "jkbms";
const APP_HOST = "app";
const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-src 'none'";
const MIME_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
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
let pickerReady = false;

app.whenReady()
  .then(() => {
    protocol.handle(APP_SCHEME, serveAppFile);
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
  if (
    !pathFromApp ||
    pathFromApp === ".." ||
    pathFromApp.startsWith(`..${path.sep}`) ||
    path.isAbsolute(pathFromApp)
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

function configureBluetoothPicker() {
  ipcMain.on("bluetooth-picker:choose", (event, deviceId) => {
    if (
      event.sender !== pickerWindow?.webContents ||
      typeof deviceId !== "string" ||
      !bluetoothDevices.some((device) => device.deviceId === deviceId)
    ) {
      return;
    }
    finishBluetoothSelection(deviceId);
  });

  ipcMain.on("bluetooth-picker:cancel", (event) => {
    if (event.sender === pickerWindow?.webContents) finishBluetoothSelection("");
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
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.on("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
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
    pickerWindow.focus();
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
