const deviceList = document.getElementById("device-list");
const deviceStatus = document.getElementById("device-status");
const cancelButton = document.getElementById("cancel-button");

window.bluetoothPicker.onDevices((devices) => {
  deviceList.replaceChildren();
  deviceStatus.textContent = devices.length
    ? "Оберіть пристрій зі списку."
    : "Пристроїв не знайдено. Перевірте, що BMS увімкнена.";

  for (const device of devices) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    const name = document.createElement("span");
    const id = document.createElement("small");

    button.type = "button";
    button.className = "device-button";
    name.className = "device-name";
    name.textContent = device.deviceName || "Пристрій без назви";
    id.className = "device-id";
    id.textContent = device.deviceId;
    button.append(name, id);
    button.addEventListener("click", () => window.bluetoothPicker.choose(device.deviceId));
    item.append(button);
    deviceList.append(item);
  }
});

cancelButton.addEventListener("click", () => window.bluetoothPicker.cancel());
