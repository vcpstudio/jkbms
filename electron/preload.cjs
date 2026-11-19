const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jkbmsDesktop", {
  onUpdateStatus(listener) {
    const handler = (_event, status) => listener(status);
    ipcRenderer.on("app-update:status", handler);
    return () => ipcRenderer.removeListener("app-update:status", handler);
  },
  checkForUpdates() {
    return ipcRenderer.invoke("app-update:check");
  },
  downloadUpdate() {
    return ipcRenderer.invoke("app-update:download");
  },
  installUpdate() {
    return ipcRenderer.invoke("app-update:install");
  },
  openReleasePage() {
    return ipcRenderer.invoke("app-update:open-release");
  },
  consumeSelectedBluetoothDevice() {
    return ipcRenderer.invoke("bluetooth-picker:consume-selected");
  },
});
