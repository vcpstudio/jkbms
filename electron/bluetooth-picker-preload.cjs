const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("bluetoothPicker", {
  onDevices(listener) {
    const handler = (_event, devices) => listener(devices);
    ipcRenderer.on("bluetooth-picker:devices", handler);
    return () => ipcRenderer.removeListener("bluetooth-picker:devices", handler);
  },
  choose(deviceId) {
    ipcRenderer.send("bluetooth-picker:choose", deviceId);
  },
  cancel() {
    ipcRenderer.send("bluetooth-picker:cancel");
  },
});
