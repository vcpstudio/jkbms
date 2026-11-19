import { resolveRecentDevices } from "../app-utils.mjs";

const deviceList = document.getElementById("device-list");
const deviceStatus = document.getElementById("device-status");
const cancelButton = document.getElementById("cancel-button");
const deviceSearch = document.getElementById("device-search");
const BLUETOOTH_PREFERENCES_KEY = "jk-bms-monitor.bluetooth-preferences.v1";
let devices = [];
let preferenceError = "";
let preferences = loadPreferences();

window.bluetoothPicker.onDevices((nextDevices) => {
  devices = nextDevices.filter(
    (device) => typeof device.deviceId === "string" && device.deviceId.length > 0,
  );
  renderDevices();
});

deviceSearch.addEventListener("input", renderDevices);
cancelButton.addEventListener("click", () => window.bluetoothPicker.cancel());

function renderDevices() {
  const query = deviceSearch.value.trim().toLocaleLowerCase();
  const visibleDevices = devices.filter((device) =>
    `${device.deviceName || ""} ${device.deviceId}`.toLocaleLowerCase().includes(query),
  );
  const recentDevices = resolveRecentDevices(preferences.recent, visibleDevices);
  const recentIds = new Set(recentDevices.map(({ deviceId }) => deviceId));
  const favoriteDevices = visibleDevices.filter(
    ({ deviceId }) => preferences.favorites.includes(deviceId) && !recentIds.has(deviceId),
  );
  const prioritizedIds = new Set([
    ...recentIds,
    ...favoriteDevices.map(({ deviceId }) => deviceId),
  ]);
  const otherDevices = visibleDevices.filter(({ deviceId }) => !prioritizedIds.has(deviceId));

  deviceList.replaceChildren();
  addDeviceGroup("Останні підключення", recentDevices);
  addDeviceGroup("Обране", favoriteDevices);
  addDeviceGroup("Знайдені пристрої", otherDevices);

  if (preferenceError) {
    deviceStatus.textContent = preferenceError;
  } else if (devices.length === 0) {
    deviceStatus.textContent = "Пристроїв не знайдено. Перевірте, що BMS увімкнена.";
  } else if (visibleDevices.length === 0) {
    deviceStatus.textContent = "За цим запитом пристроїв не знайдено.";
  } else {
    deviceStatus.textContent = "Оберіть пристрій зі списку.";
  }
}

function addDeviceGroup(label, groupDevices) {
  if (groupDevices.length === 0) return;
  const heading = document.createElement("li");
  heading.className = "device-group-title";
  heading.textContent = label;
  deviceList.append(heading);

  for (const device of groupDevices) {
    const item = document.createElement("li");
    const chooseButton = document.createElement("button");
    const name = document.createElement("span");
    const id = document.createElement("small");
    const favoriteButton = document.createElement("button");
    const favorite = preferences.favorites.includes(device.deviceId);

    item.className = "device-item";
    chooseButton.type = "button";
    chooseButton.className = "device-button";
    name.className = "device-name";
    name.textContent = device.deviceName || "Пристрій без назви";
    id.className = "device-id";
    id.textContent = device.deviceId;
    chooseButton.append(name, id);
    chooseButton.addEventListener("click", () =>
      window.bluetoothPicker.choose(device.deviceId),
    );

    favoriteButton.type = "button";
    favoriteButton.className = `favorite-button${favorite ? " is-favorite" : ""}`;
    favoriteButton.textContent = favorite ? "★" : "☆";
    favoriteButton.setAttribute(
      "aria-label",
      favorite ? "Видалити з обраного" : "Додати до обраного",
    );
    favoriteButton.title = favorite ? "Видалити з обраного" : "Додати до обраного";
    favoriteButton.addEventListener("click", () => toggleFavorite(device.deviceId));

    item.append(chooseButton, favoriteButton);
    deviceList.append(item);
  }
}

function toggleFavorite(deviceId) {
  const favorites = new Set(preferences.favorites);
  if (favorites.has(deviceId)) {
    favorites.delete(deviceId);
  } else {
    favorites.add(deviceId);
  }

  savePreferences({ ...preferences, favorites: [...favorites] });
  renderDevices();
}

function loadPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem(BLUETOOTH_PREFERENCES_KEY) || "{}");
    return {
      favorites: Array.isArray(stored.favorites)
        ? stored.favorites.filter((id) => typeof id === "string")
        : [],
      recent: Array.isArray(stored.recent)
        ? stored.recent.filter(
            (entry) =>
              entry &&
              typeof entry.id === "string" &&
              typeof entry.name === "string" &&
              typeof entry.connectedAt === "string",
          )
        : [],
    };
  } catch (error) {
    preferenceError = `Не вдалося прочитати обрані пристрої: ${error.message}`;
    return { favorites: [], recent: [] };
  }
}

function savePreferences(nextPreferences) {
  try {
    localStorage.setItem(BLUETOOTH_PREFERENCES_KEY, JSON.stringify(nextPreferences));
    preferences = nextPreferences;
    preferenceError = "";
  } catch (error) {
    preferenceError = `Не вдалося зберегти обрані пристрої: ${error.message}`;
  }
}
