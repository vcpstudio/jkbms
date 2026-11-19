import {
  CHARACTERISTIC_UUID,
  FrameAssembler,
  SERVICE_UUID,
  createCommand,
  decodeDeviceInfo,
  decodeLiveData,
  decodeSettings,
  detectProtocolVersion,
} from "./protocol.mjs";
import {
  DISCHARGE_FORECAST_WINDOW_MS,
  estimateChargeRuntime,
  estimateDischargeRuntime,
} from "./discharge-forecast.mjs";
import { FLOW_IDLE_GAP_MS, buildFlowPeriods } from "./flow-periods.mjs";
import { aggregateCellVoltageSamples } from "./voltage-chart-data.mjs";
import {
  formatCsvCell,
  minMaxValues,
  parseFlowChunkEntries,
  selectChunksToEvict,
  shouldRecordFlowSample,
} from "./app-utils.mjs";

const LOG_STORAGE_KEY = "jk-bms-monitor.measurements.v1";
const FLOW_STORAGE_KEY = "jk-bms-monitor.flow-events.v1";
const BLUETOOTH_PREFERENCES_KEY = "jk-bms-monitor.bluetooth-preferences.v1";
const DASHBOARD_LAYOUT_KEY = "jk-bms-monitor.dashboard-layout.v1";
const MAX_SAMPLES = 2000;
const MAX_FLOW_CHUNK_SAMPLES = 500;
const MAX_FLOW_CHUNKS = 20;
const MAX_FLOW_SAMPLES = MAX_FLOW_CHUNKS * MAX_FLOW_CHUNK_SAMPLES;
const FLOW_TABLE_PAGE_SIZE = 100;
const SAMPLE_INTERVAL_MS = 5000;
const CHART_SAMPLE_INTERVAL_MS = 1000;
const CHART_HISTORY_MS = 30 * 60 * 1000;
const MAX_CHART_SAMPLES = 1800;
const MAX_CHART_BUCKETS = 480;
const CHART_HEIGHT = 260;
const elements = Object.fromEntries(
  [
    "connection-indicator",
    "connection-state",
    "app-update-button",
    "dashboard-grid",
    "layout-toggle",
    "layout-reset",
    "connect-button",
    "disconnect-button",
    "refresh-button",
    "device-summary",
    "toast-container",
    "soc-value",
    "soc-bar",
    "capacity-value",
    "discharge-runtime-value",
    "discharge-runtime-detail",
    "charge-runtime-value",
    "charge-runtime-detail",
    "voltage-value",
    "average-cell-value",
    "current-value",
    "balance-value",
    "power-value",
    "mos-temperature-value",
    "spread-value",
    "cell-count-label",
    "voltage-chart",
    "chart-legend",
    "chart-mode-overview",
    "chart-mode-heatmap",
    "chart-mode-cell",
    "cell-chart-select",
    "chart-range",
    "flow-chart",
    "flow-legend",
    "flow-period-count",
    "flow-event-rows",
    "flow-older-events",
    "flow-newer-events",
    "flow-clear-events",
    "flow-table-page",
    "cells-grid",
    "last-update",
    "model-value",
    "settings-cell-count",
    "charging-value",
    "discharging-value",
    "balancing-value",
    "temperature-1-value",
    "temperature-2-value",
    "cycles-value",
    "protection-status",
    "protection-list",
    "log-count",
    "last-log",
    "export-button",
    "clear-logs-button",
  ].map((id) => [id, document.getElementById(id)]),
);

let device;
let gattServer;
let notifyCharacteristic;
let writeCharacteristic;
let commandCounter = 0;
let settings;
let protocolVersion;
let latestMeasurement;
let pendingLiveFrame;
let chartSamples = [];
let dischargeSamples = [];
let chartMode = "overview";
let selectedCellIndex = 0;
let flowSamples = [];
let flowPeriods = [];
let lastFlowCurrent;
let flowSessionId;
let flowStoragePrefix;
let flowChunkIndex = 0;
let flowChunkSamples = [];
let flowChunkDirty = false;
let flowTablePage = 0;
let flowStorageWarningShown = false;
let lastFlowSampleAt;
let flowSessionClosed = false;
let lastChartSampleAt = 0;
let assembler = new FrameAssembler();
let measurements = [];
let measurementStorageKey;
let measurementStorageWarningShown = false;
let legacyLogNoticeShown = false;
let storageWarnings = [];
let storageErrors = [];
let lastSavedAt = 0;
let sampleTimer;
const activeToasts = new Map();

renderLogSummary();
setupDashboardLayout();
renderVoltageChart();
refreshFlowPeriods();
new ResizeObserver(() => renderVoltageChart()).observe(elements["voltage-chart"]);
new ResizeObserver(() => renderFlowChart()).observe(elements["flow-chart"].parentElement);
setupIconTooltips();

elements["connect-button"].addEventListener("click", connect);
elements["disconnect-button"].addEventListener("click", disconnect);
elements["refresh-button"].addEventListener("click", requestData);
for (const button of [
  elements["chart-mode-overview"],
  elements["chart-mode-heatmap"],
  elements["chart-mode-cell"],
]) {
  button.addEventListener("click", () => setChartMode(button.dataset.chartMode));
}
elements["cell-chart-select"].addEventListener("change", () => {
  selectedCellIndex = Number(elements["cell-chart-select"].value);
  setChartMode("cell");
});
elements["chart-range"].addEventListener("change", renderVoltageChart);
elements["export-button"].addEventListener("click", exportCsv);
elements["clear-logs-button"].addEventListener("click", clearLogs);
elements["flow-older-events"].addEventListener("click", () => {
  flowTablePage += 1;
  renderFlowTable();
});
elements["flow-newer-events"].addEventListener("click", () => {
  flowTablePage = Math.max(0, flowTablePage - 1);
  renderFlowTable();
});
elements["flow-clear-events"].addEventListener("click", clearFlowEvents);
setupDesktopUpdates();
window.addEventListener("beforeunload", () => {
  recordFlowConnectionEnd();
  persistFlowChunk();
});

if (!("bluetooth" in navigator)) {
  showNotice(
    "Цей браузер не підтримує Web Bluetooth. Відкрий застосунок у Chrome або Edge на комп’ютері через localhost чи HTTPS.",
    "error",
    { persistent: true },
  );
  elements["connect-button"].disabled = true;
}

function setupIconTooltips() {
  const tooltip = document.createElement("div");
  tooltip.className = "icon-tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);

  let activeButton;
  const show = (button) => {
    const text = button.dataset.tooltip;
    if (!text || button.hidden || button.disabled) return;
    activeButton = button;
    tooltip.textContent = text;
    tooltip.hidden = false;
    const rect = button.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const margin = 8;
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin));
    let top = rect.bottom + 8;
    if (top + tooltipRect.height + margin > window.innerHeight) {
      top = rect.top - tooltipRect.height - 8;
    }
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${Math.max(margin, top)}px`;
  };
  const hide = (button) => {
    if (!button || button === activeButton) {
      tooltip.hidden = true;
      activeButton = undefined;
    }
  };
  for (const button of document.querySelectorAll("[data-tooltip]")) {
    button.addEventListener("mouseenter", () => show(button));
    button.addEventListener("mouseleave", () => hide(button));
    button.addEventListener("focus", () => show(button));
    button.addEventListener("blur", () => hide(button));
    button.addEventListener("pointerdown", () => hide(button));
    button.addEventListener("click", () => hide(button));
  }
  window.addEventListener("scroll", () => hide(), { passive: true });
  window.addEventListener("resize", () => hide());
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
}

function setupDesktopUpdates() {
  const desktop = window.jkbmsDesktop;
  const checkButton = elements["app-update-button"];
  if (!desktop) return;

  checkButton.hidden = false;

  const runUpdateAction = async (actionName) => {
    try {
      if (actionName === "download") await desktop.downloadUpdate();
      else if (actionName === "install") await desktop.installUpdate();
      else if (actionName === "release") await desktop.openReleasePage();
    } catch (error) {
      renderUpdateStatus({ state: "error", message: error.message });
    }
  };

  desktop.onUpdateStatus(renderUpdateStatus);
  checkButton.addEventListener("click", async () => {
    try {
      await desktop.checkForUpdates();
    } catch (error) {
      renderUpdateStatus({ state: "error", message: error.message });
    }
  });

  function renderUpdateStatus(status) {
    checkButton.disabled = ["checking", "downloading", "downloaded"].includes(status.state);
    checkButton.hidden = !["idle", "current", "error"].includes(status.state);

    switch (status.state) {
      case "idle":
        dismissNotice("app-update");
        return;
      case "checking":
        showNotice("Перевіряю, чи є нові версії…", "info", {
          key: "app-update",
          persistent: true,
          dismissible: false,
        });
        return;
      case "available":
        showNotice(`Доступна версія ${status.version}. Завантажити оновлення?`, "info", {
          key: "app-update",
          persistent: true,
          action: { label: "Завантажити", onClick: () => runUpdateAction("download") },
          onDismiss: () => {
            checkButton.hidden = false;
          },
        });
        return;
      case "manual":
        showNotice(
          `Доступна версія ${status.version}. Для цієї непідписаної збірки macOS встанови новий DMG вручну.`,
          "info",
          {
            key: "app-update",
            persistent: true,
            action: { label: "Відкрити реліз", onClick: () => runUpdateAction("release") },
            onDismiss: () => {
              checkButton.hidden = false;
            },
          },
        );
        return;
      case "downloading":
        showNotice(`Завантажую оновлення: ${Math.round(status.percent)}%`, "info", {
          key: "app-update",
          persistent: true,
          dismissible: false,
        });
        return;
      case "downloaded":
        showNotice(
          `Версію ${status.version} завантажено. Перезапусти застосунок для встановлення.`,
          "info",
          {
            key: "app-update",
            persistent: true,
            action: { label: "Перезапустити", onClick: () => runUpdateAction("install") },
          },
        );
        return;
      case "current":
        showNotice(`Встановлено останню версію (${status.version}).`, "info", {
          key: "app-update",
          duration: 6000,
        });
        return;
      case "error":
        showNotice(
          `Не вдалося перевірити або завантажити оновлення: ${status.message}`,
          "error",
          { key: "app-update" },
        );
        return;
      default:
        console.error("Отримано невідомий стан оновлення:", status);
        dismissNotice("app-update");
    }
  }
}

async function connect() {
  elements["connect-button"].disabled = true;
  elements["connect-button"].hidden = true;
  elements["disconnect-button"].hidden = true;
  elements["refresh-button"].hidden = true;
  showNotice("Вибери свою BMS у системному вікні Bluetooth.");

  let connectedDevice;
  try {
    connectedDevice = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    const selectedDesktopDevice =
      await window.jkbmsDesktop?.consumeSelectedBluetoothDevice?.().catch(() => null);

    if (sampleTimer) {
      window.clearInterval(sampleTimer);
      sampleTimer = undefined;
    }
    if (notifyCharacteristic) {
      notifyCharacteristic.removeEventListener("characteristicvaluechanged", handleNotification);
      notifyCharacteristic = undefined;
    }
    if (device && device !== connectedDevice) {
      device.removeEventListener("gattserverdisconnected", handleDisconnect);
    }
    device = connectedDevice;

    const storageId = getDeviceStorageId(device);
    const usesNameFallback = !device.id;
    storageWarnings = [];
    storageErrors = [];
    measurementStorageKey = makeDeviceStorageKey(LOG_STORAGE_KEY, storageId);
    flowStoragePrefix = makeDeviceStorageKey(FLOW_STORAGE_KEY, storageId) + ".";
    measurements = loadMeasurements(measurementStorageKey);
    flowSamples = enrichFlowSamples(loadFlowSamples(flowStoragePrefix), measurements).slice(
      -MAX_FLOW_SAMPLES,
    );
    flowSessionId = crypto.randomUUID();
    flowPeriods = buildFlowPeriods(flowSamples, Date.now(), FLOW_IDLE_GAP_MS, {
      activeSessionId: null,
    });
    flowChunkIndex = 0;
    flowChunkSamples = [];
    flowChunkDirty = false;
    flowTablePage = 0;
    flowStorageWarningShown = false;
    measurementStorageWarningShown = false;
    lastFlowSampleAt = undefined;
    flowSessionClosed = false;
    lastFlowCurrent = undefined;
    selectedCellIndex = 0;
    renderLogSummary();
    renderFlowTable();
    settings = undefined;
    protocolVersion = undefined;
    latestMeasurement = undefined;
    pendingLiveFrame = undefined;
    chartSamples = [];
    dischargeSamples = [];
    lastChartSampleAt = 0;
    lastSavedAt = 0;
    resetTelemetry();
    device.addEventListener("gattserverdisconnected", handleDisconnect);
    setConnectionState("Підключення…", false);

    gattServer = await device.gatt.connect();
    const service = await gattServer.getPrimaryService(SERVICE_UUID);
    const characteristics = await service.getCharacteristics(CHARACTERISTIC_UUID);
    const foundNotifyCharacteristic = characteristics.find(
      (characteristic) => characteristic.properties.notify || characteristic.properties.indicate,
    );
    writeCharacteristic = characteristics.find(
      (characteristic) =>
        characteristic.properties.write || characteristic.properties.writeWithoutResponse,
    );

    if (!foundNotifyCharacteristic || !writeCharacteristic) {
      throw new Error("У службі JK BMS не знайдено потрібні BLE-характеристики.");
    }

    assembler = new FrameAssembler();
    notifyCharacteristic = foundNotifyCharacteristic;
    notifyCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    await notifyCharacteristic.startNotifications();
    setConnectionState("Підключено", true);
    elements["device-summary"].textContent = device.name || "JK BMS через Bluetooth LE";
    elements["connect-button"].hidden = true;
    elements["disconnect-button"].disabled = false;
    elements["disconnect-button"].hidden = false;
    elements["refresh-button"].disabled = false;
    elements["refresh-button"].hidden = false;
    showNotice("З’єднання встановлено. Зчитую статус і налаштування.");
    await requestData();
    if (!gattServer?.connected || !writeCharacteristic) {
      return;
    }

    const warnings = [...storageWarnings];
    if (usesNameFallback) {
      warnings.push("Bluetooth не надав сталий ID; дані цієї BMS зберігаються за її назвою.");
    }
    if (storageErrors.length > 0) {
      showNotice(storageErrors.join(" "), "error");
    }
    if (warnings.length > 0) {
      showNotice(warnings.join(" "), "warning");
    }
    recordRecentDevice(device, selectedDesktopDevice);
    if (sampleTimer) window.clearInterval(sampleTimer);
    sampleTimer = window.setInterval(() => {
      if (latestMeasurement) recordFlowSample(latestMeasurement);
      saveCurrentMeasurement();
      if (flowChunkDirty) persistFlowChunk();
      refreshFlowPeriods();
    }, SAMPLE_INTERVAL_MS);
  } catch (error) {
    elements["connect-button"].disabled = false;
    elements["connect-button"].hidden = false;
    elements["disconnect-button"].disabled = true;
    elements["disconnect-button"].hidden = true;
    elements["refresh-button"].disabled = true;
    elements["refresh-button"].hidden = true;
    if (error.name === "NotFoundError") {
      return;
    }
    if (notifyCharacteristic) {
      notifyCharacteristic.removeEventListener("characteristicvaluechanged", handleNotification);
      notifyCharacteristic = undefined;
    }
    writeCharacteristic = undefined;
    if (connectedDevice) {
      connectedDevice.removeEventListener("gattserverdisconnected", handleDisconnect);
      if (connectedDevice.gatt?.connected) connectedDevice.gatt.disconnect();
    }
    const extraMessages = [...storageErrors, ...storageWarnings];
    const storageMessage = extraMessages.length ? ` ${extraMessages.join(" ")}` : "";
    showNotice(`Не вдалося підключитися: ${error.message}${storageMessage}`, "error");
    setConnectionState("Не підключено", false);
  }
}

async function requestData() {
  if (!writeCharacteristic || !gattServer?.connected) {
    showNotice("Спочатку підключи JK BMS.", "error");
    return;
  }

  try {
    await writeCommand(0x96);
    await new Promise((resolve) => window.setTimeout(resolve, 400));
    await writeCommand(0x97);
    showNotice("Запити на читання надіслано. Очікую відповіді BMS.");
  } catch (error) {
    showNotice(`Помилка запиту даних: ${error.message}`, "error");
  }
}

async function writeCommand(command) {
  const frame = createCommand(command, commandCounter);
  commandCounter = (commandCounter + 1) & 0xff;

  if (writeCharacteristic.properties.write && writeCharacteristic.writeValueWithResponse) {
    await writeCharacteristic.writeValueWithResponse(frame);
  } else if (writeCharacteristic.writeValueWithoutResponse) {
    await writeCharacteristic.writeValueWithoutResponse(frame);
  } else {
    await writeCharacteristic.writeValue(frame);
  }
}

function handleNotification(event) {
  const dataView = event.target.value;
  const bytes = new Uint8Array(dataView.buffer, dataView.byteOffset, dataView.byteLength);

  for (const frame of assembler.push(bytes)) {
    try {
      handleFrame(frame);
    } catch (error) {
      showNotice(`Не вдалося обробити відповідь BMS: ${error.message}`, "error");
    }
  }
}

function handleFrame(frame) {
  switch (frame[4]) {
    case 0x01:
      settings = decodeSettings(frame);
      elements["settings-cell-count"].textContent = String(settings.cellCount);
      elements["cell-count-label"].textContent = `(${settings.cellCount})`;
      updateCellSelector(settings.cellCount);
      elements["charging-value"].textContent = settings.chargingEnabled ? "Увімкнено" : "Вимкнено";
      elements["discharging-value"].textContent = settings.dischargingEnabled ? "Увімкнено" : "Вимкнено";
      elements["balancing-value"].textContent = settings.balancingEnabled ? "Увімкнено" : "Вимкнено";
      if (latestMeasurement) {
        renderMeasurement(latestMeasurement);
      }
      if (pendingLiveFrame && protocolVersion) renderPendingLiveData();
      break;
    case 0x02:
      if (!settings || !protocolVersion) {
        pendingLiveFrame = frame;
        showNotice("Отримано дані комірок; визначаю профіль протоколу BMS.", "info", {
          key: "protocol-detect",
        });
        return;
      }
      renderLiveData(frame);
      break;
    case 0x03: {
      const info = decodeDeviceInfo(frame);
      if (!protocolVersion) {
        protocolVersion = detectProtocolVersion(info, device?.name || "");
      }
      if (info.model) {
        elements["model-value"].textContent = info.model;
        elements["device-summary"].textContent = `${info.model}${
          info.firmwareVersion ? ` · прошивка ${info.firmwareVersion}` : ""
        } · ${protocolVersion}`;
      }
      if (pendingLiveFrame && settings) renderPendingLiveData();
      break;
    }
    default:
      showNotice(`Отримано невідомий тип кадру: 0x${frame[4].toString(16).padStart(2, "0")}.`);
  }
}

function renderPendingLiveData() {
  const frame = pendingLiveFrame;
  pendingLiveFrame = undefined;
  renderLiveData(frame);
}

function renderLiveData(frame) {
  dismissNotice("protocol-detect");
  latestMeasurement = decodeLiveData(frame, settings.cellCount, protocolVersion);
  recordDischargeSample(latestMeasurement);
  renderMeasurement(latestMeasurement);
  recordChartSample(latestMeasurement);
  recordFlowSample(latestMeasurement);
  saveCurrentMeasurement();
}

function renderMeasurement(measurement) {
  elements["soc-value"].textContent = String(measurement.stateOfCharge);
  elements["soc-bar"].style.width = `${Math.max(0, Math.min(100, measurement.stateOfCharge))}%`;
  elements["capacity-value"].textContent = format(measurement.remainingCapacity, 1);
  elements["voltage-value"].textContent = format(measurement.voltage, 2);
  elements["average-cell-value"].textContent = format(measurement.averageCellVoltage, 3);
  elements["current-value"].textContent = format(measurement.current, 2);
  elements["balance-value"].textContent = format(measurement.balanceCurrent, 2);
  elements["power-value"].textContent = format(measurement.power, 0);
  elements["mos-temperature-value"].textContent = format(measurement.mosTemperature, 1);
  elements["spread-value"].textContent = String(Math.round(measurement.cellVoltageDelta * 1000));
  elements["temperature-1-value"].textContent = `${format(measurement.temperature1, 1)} °C`;
  elements["temperature-2-value"].textContent = `${format(measurement.temperature2, 1)} °C`;
  elements["cycles-value"].textContent = String(measurement.cycleCount);
  elements["last-update"].textContent = new Date(measurement.timestamp).toLocaleTimeString("uk-UA");
  renderDischargeForecast(estimateDischargeRuntime(dischargeSamples));
  renderChargeForecast(estimateChargeRuntime(dischargeSamples));
  renderCells(measurement.cellVoltages, measurement.cellResistances);
  renderProtection(measurement.protectionAlerts, measurement.unknownProtectionMask);
}

function resetTelemetry() {
  for (const id of [
    "soc-value",
    "capacity-value",
    "voltage-value",
    "average-cell-value",
    "current-value",
    "balance-value",
    "power-value",
    "mos-temperature-value",
    "spread-value",
    "cell-count-label",
    "settings-cell-count",
    "charging-value",
    "discharging-value",
    "balancing-value",
    "temperature-1-value",
    "temperature-2-value",
    "cycles-value",
    "discharge-runtime-value",
    "discharge-runtime-detail",
    "charge-runtime-value",
    "charge-runtime-detail",
  ]) {
    elements[id].textContent = "—";
  }
  dischargeSamples = [];
  renderDischargeForecast({ status: "unavailable" });
  renderChargeForecast({ status: "unavailable" });
  elements["protection-status"].textContent = "Очікування телеметрії BMS";
  elements["protection-status"].dataset.state = "unknown";
  elements["protection-list"].replaceChildren();
  elements["protection-list"].hidden = true;
  elements["soc-bar"].style.width = "0";
  elements["model-value"].textContent = "Не визначена";
  elements["cells-grid"].innerHTML = '<p class="empty-state">Дані комірок з’являться після підключення.</p>';
  elements["last-update"].textContent = "Очікування даних";
  renderVoltageChart([]);
  renderFlowChart();
  elements["chart-legend"].replaceChildren();
}

function renderProtection(alerts, unknownMask) {
  const status = elements["protection-status"];
  const list = elements["protection-list"];
  const items = [...alerts];
  if (unknownMask !== 0) {
    items.push({
      label: `Невідомі біти статусу BMS: 0x${unknownMask.toString(16).padStart(8, "0")}`,
      severity: "warning",
    });
  }

  list.replaceChildren(
    ...items.map((item) => {
      const entry = document.createElement("li");
      entry.className = `protection-alert is-${item.severity}`;
      entry.textContent = item.label;
      return entry;
    }),
  );
  list.hidden = items.length === 0;

  const hasCritical = items.some((item) => item.severity === "critical");
  const hasWarning = items.some((item) => item.severity === "warning");
  const hasInfo = items.length > 0;
  status.dataset.state = hasCritical ? "critical" : hasWarning ? "warning" : hasInfo ? "info" : "ok";
  status.textContent = hasCritical
    ? "За останнім кадром: активний критичний стан BMS"
    : hasWarning
      ? "За останнім кадром: BMS повідомляє про проблему"
      : hasInfo
        ? "За останнім кадром: є інформаційні стани"
        : "За останнім кадром активних тривог не зафіксовано";
}

function renderCells(cellVoltages, cellResistances) {
  const values = cellVoltages.filter((value) => value > 0);
  if (values.length === 0) {
    elements["cells-grid"].innerHTML = '<p class="empty-state">BMS ще не надіслала напруги комірок.</p>';
    return;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const fragment = document.createDocumentFragment();

  cellVoltages.forEach((voltage, index) => {
    const cell = document.createElement("div");
    const label = document.createElement("span");
    const value = document.createElement("span");
    const resistance = document.createElement("span");
    cell.className = "cell";
    cell.dataset.cellIndex = String(index);
    cell.setAttribute("role", "button");
    cell.setAttribute(
      "aria-label",
      `Вибрати комірку ${index + 1} для детального графіка`,
    );
    cell.setAttribute("aria-pressed", String(chartMode === "cell" && selectedCellIndex === index));
    cell.tabIndex = 0;
    if (chartMode === "cell" && selectedCellIndex === index) {
      cell.classList.add("is-chart-selected");
    }
    if (voltage === min) cell.classList.add("is-low");
    if (voltage === max) cell.classList.add("is-high");
    label.className = "cell-number";
    label.textContent = `CELL ${String(index + 1).padStart(2, "0")}`;
    value.className = "cell-voltage";
    value.textContent = voltage > 0 ? voltage.toFixed(3) : "—";
    resistance.className = "cell-resistance";
    const resistanceValue = cellResistances[index];
    resistance.textContent =
      Number.isFinite(resistanceValue) && resistanceValue > 0
        ? `Опір ${Math.round(resistanceValue * 1000)} mΩ`
        : "Опір —";
    cell.append(label, value, resistance);
    cell.addEventListener("click", () => selectCellForChart(index));
    cell.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectCellForChart(index);
    });
    fragment.append(cell);
  });

  elements["cells-grid"].replaceChildren(fragment);
}

function recordChartSample(measurement) {
  const timestamp = Date.parse(measurement.timestamp);
  if (timestamp - lastChartSampleAt < CHART_SAMPLE_INTERVAL_MS) return;

  chartSamples.push({
    timestamp,
    cellVoltages: [...measurement.cellVoltages],
  });
  lastChartSampleAt = timestamp;
  const oldestAllowed = timestamp - CHART_HISTORY_MS;
  chartSamples = chartSamples
    .filter((sample) => sample.timestamp >= oldestAllowed)
    .slice(-MAX_CHART_SAMPLES);
  renderVoltageChart();
}

function recordDischargeSample(measurement) {
  const timestamp = Date.parse(measurement.timestamp);
  const fullCapacity =
    Number.isFinite(measurement.nominalCapacity) && measurement.nominalCapacity > 0
      ? measurement.nominalCapacity
      : measurement.stateOfCharge > 0
        ? measurement.remainingCapacity / (measurement.stateOfCharge / 100)
        : undefined;
  dischargeSamples.push({
    timestamp,
    current: measurement.current,
    power: measurement.power,
    remainingCapacity: measurement.remainingCapacity,
    stateOfCharge: measurement.stateOfCharge,
    fullCapacity,
  });
  const oldestAllowed = timestamp - DISCHARGE_FORECAST_WINDOW_MS;
  dischargeSamples = dischargeSamples
    .filter((sample) => sample.timestamp >= oldestAllowed)
    .slice(-1800);
}

function renderDischargeForecast(forecast) {
  const value = elements["discharge-runtime-value"];
  const detail = elements["discharge-runtime-detail"];
  const card = value.closest(".metric-card");
  card.dataset.state = forecast.status;

  if (forecast.status === "discharging") {
    value.textContent = formatDischargeDuration(forecast.runtimeHours);
    const consumption = Number.isFinite(forecast.averagePower)
      ? forecast.averagePower >= 1000
        ? `${(forecast.averagePower / 1000).toFixed(1)} kW`
        : `${forecast.averagePower.toFixed(0)} W`
      : "";
    const source = forecast.method === "average" ? "Середнє" : "Поточне";
    detail.textContent =
      `${source}: ${forecast.averageCurrent.toFixed(1)} A` +
      (consumption ? ` · ${consumption}` : "");
    detail.title =
      `Оцінка за ${forecast.method === "average" ? "середнім" : "поточним"} струмом розряду` +
      (forecast.method === "average" ? " за доступний період до 5 хв" : "") +
      ` ${forecast.averageCurrent.toFixed(2)} A; залишкова ємність BMS ` +
      `${forecast.remainingCapacity.toFixed(2)} Ah.`;
    return;
  }

  value.textContent = "—";
  detail.removeAttribute("title");
  detail.textContent =
    forecast.status === "charging"
      ? "Заряджається — прогноз розряду неактивний"
      : forecast.status === "idle"
        ? "Немає розрядного навантаження"
        : forecast.status === "depleted"
          ? "Залишкова ємність вичерпана"
          : forecast.status === "disconnected"
            ? "Немає активного з’єднання"
            : "Оцінка з’явиться під час розряду";
}

function renderChargeForecast(forecast) {
  const value = elements["charge-runtime-value"];
  const detail = elements["charge-runtime-detail"];
  const card = value.closest(".metric-card");
  card.dataset.state = forecast.status;

  if (forecast.status === "charging") {
    value.textContent = formatDischargeDuration(forecast.runtimeHours);
    const chargingPower = Number.isFinite(forecast.averagePower)
      ? forecast.averagePower >= 1000
        ? `${(forecast.averagePower / 1000).toFixed(1)} kW`
        : `${forecast.averagePower.toFixed(0)} W`
      : "";
    const source = forecast.method === "average" ? "Середнє" : "Поточне";
    detail.textContent =
      `${source}: ${forecast.averageCurrent.toFixed(1)} A` +
      (chargingPower ? ` · ${chargingPower}` : "");
    detail.title =
      `Оцінка за ${forecast.method === "average" ? "середнім" : "поточним"} струмом заряджання` +
      (forecast.method === "average" ? " за доступний період до 5 хв" : "") +
      ` ${forecast.averageCurrent.toFixed(2)} A; до повного заряду ` +
      `${forecast.remainingCapacity.toFixed(2)} Ah при SOC ${forecast.stateOfCharge}%.`;
    return;
  }

  value.textContent = "—";
  detail.removeAttribute("title");
  detail.textContent =
    forecast.status === "full"
      ? "Акумулятор повністю заряджений"
      : forecast.status === "discharging"
        ? "Розряджається — прогноз заряду неактивний"
        : forecast.status === "idle"
          ? "Немає зарядного струму"
          : forecast.status === "disconnected"
            ? "Немає активного з’єднання"
            : "Оцінка з’явиться під час заряджання";
}

function formatDischargeDuration(runtimeHours) {
  const totalMinutes = Math.round(runtimeHours * 60);
  if (totalMinutes < 1) return "<1 хв";

  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} д ${hours} год`;
  if (hours === 0) return `${minutes} хв`;
  return minutes > 0 ? `${hours} год ${minutes} хв` : `${hours} год`;
}

function recordFlowSample(measurement) {
  const timestamp = Date.parse(measurement.timestamp);
  const current = measurement.current;
  if (
    flowSessionClosed ||
    !shouldRecordFlowSample({
      current,
      previousCurrent: lastFlowCurrent,
      timestamp,
      lastSampleAt: lastFlowSampleAt,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
    })
  ) {
    return;
  }

  lastFlowCurrent = current;
  const sample = {
    timestamp,
    current,
    voltage: measurement.voltage,
    power: measurement.power,
    stateOfCharge: measurement.stateOfCharge,
    sessionId: flowSessionId,
  };
  flowSamples.push(sample);
  if (flowSamples.length > MAX_FLOW_SAMPLES) {
    flowSamples = flowSamples.slice(-MAX_FLOW_SAMPLES);
  }
  flowChunkSamples.push([
    timestamp,
    current,
    measurement.voltage,
    measurement.power,
    measurement.stateOfCharge,
  ]);
  flowChunkDirty = true;
  lastFlowSampleAt = timestamp;
  if (flowChunkSamples.length >= MAX_FLOW_CHUNK_SAMPLES) {
    persistFlowChunk();
  }
}

function recordFlowConnectionEnd() {
  if (flowSessionClosed || !flowStoragePrefix || !flowSessionId || !latestMeasurement) return;

  const lastMeasurementAt = Date.parse(latestMeasurement.timestamp);
  const timestamp = Math.max(
    lastMeasurementAt,
    Math.min(Date.now(), lastMeasurementAt + SAMPLE_INTERVAL_MS),
  );
  const sample = {
    timestamp,
    current: latestMeasurement.current,
    voltage: latestMeasurement.voltage,
    power: latestMeasurement.power,
    stateOfCharge: latestMeasurement.stateOfCharge,
    sessionId: flowSessionId,
    kind: "connection-end",
  };
  flowSamples.push(sample);
  if (flowSamples.length > MAX_FLOW_SAMPLES) {
    flowSamples = flowSamples.slice(-MAX_FLOW_SAMPLES);
  }
  flowChunkSamples.push([
    timestamp,
    sample.current,
    sample.voltage,
    sample.power,
    sample.stateOfCharge,
    sample.kind,
  ]);
  flowChunkDirty = true;
  flowSessionClosed = true;
  persistFlowChunk();
  refreshFlowPeriods();
}

function getStoredFlowChunkSummaries(storagePrefix) {
  const summaries = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(storagePrefix)) continue;
    let oldestTimestamp = 0;
    try {
      const chunk = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(chunk) && Array.isArray(chunk[0]) && Number.isFinite(chunk[0][0])) {
        oldestTimestamp = chunk[0][0];
      }
    } catch {
      oldestTimestamp = 0;
    }
    summaries.push({ key, oldestTimestamp });
  }
  return summaries;
}

function evictExcessFlowChunks(storagePrefix, maxChunks, protectedKey) {
  const summaries = getStoredFlowChunkSummaries(storagePrefix);
  const keysToRemove = selectChunksToEvict(summaries, maxChunks, protectedKey);
  for (const key of keysToRemove) {
    localStorage.removeItem(key);
  }
  return keysToRemove.length;
}

function persistFlowChunk() {
  if (!flowStoragePrefix || !flowChunkDirty || flowChunkSamples.length === 0) return;

  const chunkKey = `${flowStoragePrefix}${flowSessionId}.${flowChunkIndex}`;
  const serialized = JSON.stringify(flowChunkSamples);
  try {
    localStorage.setItem(chunkKey, serialized);
    evictExcessFlowChunks(flowStoragePrefix, MAX_FLOW_CHUNKS, chunkKey);
    flowChunkDirty = false;
    flowStorageWarningShown = false;
    if (flowChunkSamples.length >= MAX_FLOW_CHUNK_SAMPLES) {
      flowChunkIndex += 1;
      flowChunkSamples = [];
    }
  } catch (error) {
    const summaries = getStoredFlowChunkSummaries(flowStoragePrefix);
    const evicted = evictExcessFlowChunks(
      flowStoragePrefix,
      Math.max(1, summaries.length - 2),
      chunkKey,
    );
    if (evicted > 0) {
      try {
        localStorage.setItem(chunkKey, serialized);
        flowChunkDirty = false;
        flowStorageWarningShown = false;
        if (flowChunkSamples.length >= MAX_FLOW_CHUNK_SAMPLES) {
          flowChunkIndex += 1;
          flowChunkSamples = [];
        }
        return;
      } catch {
        // Fall through to report storage error once.
      }
    }
    if (!flowStorageWarningShown) {
      showNotice(`Не вдалося зберегти події струму для цієї BMS: ${error.message}`, "error");
      flowStorageWarningShown = true;
    }
  }
}

function refreshFlowPeriods() {
  flowPeriods = buildFlowPeriods(flowSamples, Date.now(), FLOW_IDLE_GAP_MS, {
    activeSessionId: device?.gatt?.connected ? flowSessionId : null,
  });
  renderFlowTable();
  renderFlowChart();
}

function renderFlowTable() {
  const periods = flowPeriods;
  const pageCount = Math.max(1, Math.ceil(periods.length / FLOW_TABLE_PAGE_SIZE));
  flowTablePage = Math.min(flowTablePage, pageCount - 1);
  const end = periods.length - flowTablePage * FLOW_TABLE_PAGE_SIZE;
  const start = Math.max(0, end - FLOW_TABLE_PAGE_SIZE);
  const visiblePeriods = periods.slice(start, end).reverse();
  const rows = visiblePeriods.map((period) => {
    const row = document.createElement("tr");
    const time = document.createElement("td");
    const type = document.createElement("td");
    const duration = document.createElement("td");
    const stateOfCharge = document.createElement("td");
    const energy = document.createElement("td");
    const voltage = document.createElement("td");
    const current = document.createElement("td");
    const endMarker = period.endBoundaryKnown ? "" : "≈ ";

    row.className = `flow-event-${period.direction}`;
    time.textContent =
      `${period.startBoundaryKnown ? "" : "≈ "}${formatFlowTimestamp(period.startTimestamp)} – ` +
      `${endMarker}${formatFlowTimestamp(period.endTimestamp)}${flowPeriodStatus(period.status)}`;
    type.textContent = period.direction === "charge" ? "Заряджання" : "Розряджання";
    duration.textContent = formatFlowDuration(period.activeDurationMs);
    stateOfCharge.textContent = formatFlowSoc(period);
    energy.textContent = Number.isFinite(period.energyKwh)
      ? period.energyKwh.toFixed(3)
      : "—";
    voltage.textContent = Number.isFinite(period.averageVoltage)
      ? period.averageVoltage.toFixed(1)
      : "—";
    current.textContent =
      Number.isFinite(period.minCurrent) && Number.isFinite(period.maxCurrent)
        ? `${period.minCurrent.toFixed(1)}–${period.maxCurrent.toFixed(1)}`
        : "—";
    row.append(time, type, duration, stateOfCharge, energy, voltage, current);
    return row;
  });

  elements["flow-event-rows"].replaceChildren(
    ...(rows.length ? rows : [createEmptyFlowTableRow()]),
  );
  elements["flow-period-count"].textContent = `Періоди: ${periods.length}`;
  elements["flow-table-page"].textContent = periods.length
    ? `${start + 1}–${end} з ${periods.length}`
    : "Періодів ще немає";
  elements["flow-older-events"].disabled = start === 0;
  elements["flow-newer-events"].disabled = flowTablePage === 0;
  elements["flow-clear-events"].disabled = flowSamples.length === 0;
}

function formatFlowTimestamp(timestamp) {
  return new Date(timestamp).toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatFlowDuration(durationMs) {
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} год ${minutes} хв`;
  if (minutes > 0) return `${minutes} хв ${totalSeconds % 60} с`;
  return `${totalSeconds} с`;
}

function formatFlowSoc(period) {
  if (!Number.isFinite(period.startSoc) || !Number.isFinite(period.endSoc)) return "—";
  const change = period.endSoc - period.startSoc;
  const changeLabel = `${change > 0 ? "+" : ""}${change.toFixed(0)}%`;
  return `${period.startSoc.toFixed(0)}→${period.endSoc.toFixed(0)}% (${changeLabel})`;
}

function flowPeriodStatus(status) {
  if (status === "active") return " (триває)";
  if (status === "paused") return " (пауза)";
  if (status === "connection-ended") return " (від’єднано)";
  if (status === "interrupted") return " (перервано)";
  return "";
}

function createEmptyFlowTableRow() {
  const row = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = 7;
  cell.className = "flow-table-empty";
  cell.textContent = "Періодів заряду або розряду ще не зафіксовано";
  row.append(cell);
  return row;
}

function clearFlowEvents() {
  if (!flowStoragePrefix) return;
  if (!window.confirm("Видалити історію заряду та розряду цієї BMS?")) return;

  try {
    const keys = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(flowStoragePrefix)) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    flowSamples = [];
    flowChunkSamples = [];
    flowChunkDirty = false;
    flowChunkIndex = 0;
    lastFlowCurrent = undefined;
    lastFlowSampleAt = undefined;
    flowTablePage = 0;
    flowSessionClosed = !device?.gatt?.connected;
    refreshFlowPeriods();
    showNotice("Історію подій струму цієї BMS очищено.");
  } catch (error) {
    showNotice(`Не вдалося очистити історію цієї BMS: ${error.message}`, "error");
  }
}

function renderVoltageChart() {
  const chart = elements["voltage-chart"];
  const chartWidth = chart.clientWidth || 800;
  chart.setAttribute("viewBox", `0 0 ${chartWidth} ${CHART_HEIGHT}`);
  chart.replaceChildren();
  elements["chart-legend"].replaceChildren();

  if (chartSamples.length === 0) {
    const empty = svgElement("text", {
      class: "chart-empty",
      x: chartWidth / 2,
      y: 126,
      "text-anchor": "middle",
    });
    empty.textContent = "Графік з’явиться після отримання вимірювань";
    chart.append(empty);
    return;
  }

  const bounds = { left: 72, right: chartWidth - 18, top: 20, bottom: 204 };
  if (bounds.right <= bounds.left) return;
  const rangeMs = Number(elements["chart-range"].value);
  const lastTimestamp = chartSamples.at(-1).timestamp;
  const firstTimestamp = lastTimestamp - rangeMs;
  const visibleSamples = chartSamples.filter((sample) => sample.timestamp >= firstTimestamp);
  const cellCount = visibleSamples.reduce(
    (maximum, sample) => Math.max(maximum, sample.cellVoltages.length),
    0,
  );
  const selectedVoltages =
    chartMode === "cell"
      ? visibleSamples.map((sample) => sample.cellVoltages[selectedCellIndex])
      : visibleSamples.flatMap((sample) => sample.cellVoltages);
  const voltages = selectedVoltages.filter((value) => Number.isFinite(value) && value > 0);
  const range = minMaxValues(voltages);
  if (!range || cellCount === 0) {
    const empty = svgElement("text", {
      class: "chart-empty",
      x: chartWidth / 2,
      y: 126,
      "text-anchor": "middle",
    });
    empty.textContent = "Для цього періоду ще немає даних";
    chart.append(empty);
    return;
  }

  const dataMin = range.min;
  const dataMax = range.max;
  const padding = Math.max((dataMax - dataMin) * 0.25, 0.005);
  const minVoltage = Math.floor((dataMin - padding) * 1000) / 1000;
  const maxVoltage = Math.ceil((dataMax + padding) * 1000) / 1000;
  const voltageRange = maxVoltage - minVoltage || 0.01;
  const timeRange = rangeMs;
  const x = (timestamp) =>
    bounds.left + ((timestamp - firstTimestamp) / timeRange) * (bounds.right - bounds.left);
  const y = (voltage) =>
    bounds.bottom - ((voltage - minVoltage) / voltageRange) * (bounds.bottom - bounds.top);
  const maxBuckets = Math.max(
    1,
    Math.min(MAX_CHART_BUCKETS, Math.floor(bounds.right - bounds.left)),
  );
  const buckets = aggregateCellVoltageSamples(
    visibleSamples,
    maxBuckets,
    firstTimestamp,
    lastTimestamp,
  );

  if (chartMode !== "heatmap") {
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = minVoltage + (voltageRange * tick) / 4;
      const lineY = y(value);
      chart.append(
        svgElement("line", {
          class: "chart-grid-line",
          x1: bounds.left,
          x2: bounds.right,
          y1: lineY,
          y2: lineY,
        }),
      );
      const label = svgElement("text", {
        class: "chart-axis-label",
        x: bounds.left - 10,
        y: lineY + 3,
        "text-anchor": "end",
      });
      label.textContent = value.toFixed(3);
      chart.append(label);
    }
  }

  const formatTime = (timestamp) =>
    new Date(timestamp).toLocaleTimeString("uk-UA", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  const timeLabels = new Set();
  for (let tick = 0; tick <= 4; tick += 1) {
    const timestamp = firstTimestamp + (timeRange * tick) / 4;
    const labelText = formatTime(timestamp);
    if (timeLabels.has(labelText)) continue;
    timeLabels.add(labelText);
    const label = svgElement("text", {
      class: "chart-x-label",
      x: x(timestamp),
      y: bounds.bottom + 24,
      "text-anchor": "middle",
    });
    label.textContent = labelText;
    chart.append(label);
  }

  const axisTitle = svgElement("text", {
    class: "chart-x-label",
    x: (bounds.left + bounds.right) / 2,
    y: 249,
    "text-anchor": "middle",
  });
  axisTitle.textContent = "Час";
  chart.append(axisTitle);

  if (chartMode === "heatmap") {
    renderVoltageHeatmap(chart, buckets, bounds, dataMin, dataMax, cellCount);
  } else {
    const selectedCell = chartMode === "cell" ? selectedCellIndex : undefined;
    const series = buckets
      .map((bucket) => {
        if (selectedCell === undefined) {
          return {
            timestamp: bucket.timestamp,
            minimum: bucket.minimum,
            maximum: bucket.maximum,
            average: bucket.average,
          };
        }
        const cell = bucket.cells[selectedCell];
        return cell ? { timestamp: bucket.timestamp, ...cell } : undefined;
      })
      .filter((point) => point && Number.isFinite(point.average));
    if (series.length === 0) return;

    const upperPath = series
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${x(point.timestamp)} ${y(point.maximum)}`,
      )
      .join(" ");
    const lowerPath = [...series]
      .reverse()
      .map((point) => `L ${x(point.timestamp)} ${y(point.minimum)}`)
      .join(" ");
    const rangeBand = svgElement("path", {
      class: "chart-range-band",
      d: `${upperPath} ${lowerPath} Z`,
    });
    const bandTitle = svgElement("title");
    bandTitle.textContent = "Діапазон мінімальної та максимальної напруги";
    rangeBand.append(bandTitle);
    chart.append(rangeBand);

    const averagePath = series
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"} ${x(point.timestamp)} ${y(point.average)}`,
      )
      .join(" ");
    const averageLine = svgElement("path", {
      class: "chart-average-line",
      d: averagePath,
    });
    const averageTitle = svgElement("title");
    averageTitle.textContent =
      selectedCell === undefined
        ? "Середня напруга всіх комірок"
        : `Середня напруга комірки ${selectedCell + 1}`;
    averageLine.append(averageTitle);
    chart.append(averageLine);

    const latestPoint = series.at(-1);
    const marker = svgElement("circle", {
      class: "chart-point",
      cx: x(latestPoint.timestamp),
      cy: y(latestPoint.average),
      r: 3,
      fill: "#b7f36a",
      stroke: "#b7f36a",
    });
    const markerTitle = svgElement("title");
    markerTitle.textContent = `${latestPoint.average.toFixed(3)} V`;
    marker.append(markerTitle);
    chart.append(marker);

    renderChartLegend([
      { kind: "range", label: "Мінімум – максимум" },
      { color: "#b7f36a", label: selectedCell === undefined ? "Середнє всіх комірок" : "Середнє комірки" },
    ]);
  }

  chart.setAttribute(
    "aria-label",
    chartMode === "heatmap"
      ? `Теплова карта напруги ${cellCount} комірок за ${elements["chart-range"].selectedOptions[0].textContent}.`
      : chartMode === "cell"
        ? `Детальний графік напруги комірки ${selectedCellIndex + 1}.`
        : `Огляд мінімальної, середньої та максимальної напруги ${cellCount} комірок.`,
  );
}

function renderVoltageHeatmap(chart, buckets, bounds, dataMin, dataMax, cellCount) {
  const bucketCount = buckets[0].bucketCount;
  const rowHeight = (bounds.bottom - bounds.top) / cellCount;
  const canvas = document.createElement("canvas");
  canvas.width = bucketCount;
  canvas.height = cellCount;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не вдалося створити теплову карту напруги.");
  const imageData = context.createImageData(bucketCount, cellCount);

  for (const bucket of buckets) {
    bucket.cells.forEach((cell, cellIndex) => {
      if (!cell) return;
      const pixelOffset = (cellIndex * bucketCount + bucket.index) * 4;
      const [red, green, blue] = voltageHeatmapRgb(cell.average, dataMin, dataMax);
      imageData.data[pixelOffset] = red;
      imageData.data[pixelOffset + 1] = green;
      imageData.data[pixelOffset + 2] = blue;
      imageData.data[pixelOffset + 3] = 255;
    });
  }
  context.putImageData(imageData, 0, 0);

  const image = svgElement("image", {
    x: bounds.left,
    y: bounds.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top,
    preserveAspectRatio: "none",
    href: canvas.toDataURL("image/png"),
  });
  const title = svgElement("title");
  title.textContent =
    `Теплова карта: ${cellCount} комірок, напруга ${dataMin.toFixed(3)}–${dataMax.toFixed(3)} V`;
  image.append(title);
  chart.insertBefore(image, chart.firstChild);

  const labelStep = Math.max(1, Math.ceil(cellCount / 10));
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += labelStep) {
    const label = svgElement("text", {
      class: "chart-axis-label",
      x: bounds.left - 10,
      y: bounds.top + (cellIndex + 0.5) * rowHeight + 3,
      "text-anchor": "end",
    });
    label.textContent = String(cellIndex + 1);
    chart.append(label);
  }

  renderChartLegend([
    { color: voltageHeatmapColor(dataMin, dataMin, dataMax), label: `${dataMin.toFixed(3)} V` },
    {
      color: voltageHeatmapColor((dataMin + dataMax) / 2, dataMin, dataMax),
      label: `${((dataMin + dataMax) / 2).toFixed(3)} V`,
    },
    { color: voltageHeatmapColor(dataMax, dataMin, dataMax), label: `${dataMax.toFixed(3)} V` },
  ]);
}

function voltageHeatmapColor(value, minimum, maximum) {
  return `rgb(${voltageHeatmapRgb(value, minimum, maximum).join(" ")})`;
}

function voltageHeatmapRgb(value, minimum, maximum) {
  const stops = [
    { position: 0, color: [56, 109, 160] },
    { position: 0.5, color: [87, 166, 112] },
    { position: 1, color: [224, 194, 83] },
  ];
  const ratio = maximum === minimum ? 0.5 : Math.max(0, Math.min(1, (value - minimum) / (maximum - minimum)));
  const stopIndex = ratio <= 0.5 ? 0 : 1;
  const start = stops[stopIndex];
  const end = stops[stopIndex + 1];
  const localRatio = (ratio - start.position) / (end.position - start.position);
  const rgb = start.color.map((channel, index) =>
    Math.round(channel + (end.color[index] - channel) * localRatio),
  );
  return rgb;
}

function renderChartLegend(items) {
  elements["chart-legend"].replaceChildren(
    ...items.map(({ color, kind, label }) => {
      const item = document.createElement("span");
      const swatch = document.createElement("i");
      const text = document.createElement("span");
      item.className = "chart-legend-item";
      swatch.className = `chart-legend-swatch${kind === "range" ? " is-range" : ""}`;
      if (color) swatch.style.backgroundColor = color;
      text.textContent = label;
      item.append(swatch, text);
      return item;
    }),
  );
}

function updateCellSelector(cellCount) {
  const select = elements["cell-chart-select"];
  if (select.options.length !== cellCount) {
    select.replaceChildren(
      ...Array.from({ length: cellCount }, (_, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `Комірка ${index + 1}`;
        return option;
      }),
    );
  }
  selectedCellIndex = Math.min(selectedCellIndex, cellCount - 1);
  select.value = String(selectedCellIndex);
}

function selectCellForChart(cellIndex) {
  selectedCellIndex = cellIndex;
  elements["cell-chart-select"].value = String(cellIndex);
  setChartMode("cell");
}

function setChartMode(mode) {
  if (!["overview", "heatmap", "cell"].includes(mode)) {
    throw new Error(`Невідомий режим графіка напруги: ${mode}.`);
  }
  chartMode = mode;
  for (const button of [
    elements["chart-mode-overview"],
    elements["chart-mode-heatmap"],
    elements["chart-mode-cell"],
  ]) {
    const active = button.dataset.chartMode === chartMode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  for (const cell of elements["cells-grid"].querySelectorAll(".cell")) {
    const active =
      chartMode === "cell" && Number(cell.dataset.cellIndex) === selectedCellIndex;
    cell.classList.toggle("is-chart-selected", active);
    cell.setAttribute("aria-pressed", String(active));
  }
  renderVoltageChart();
}

function renderFlowChart() {
  const chart = elements["flow-chart"];
  const periods = flowPeriods;
  const containerWidth = chart.parentElement.clientWidth || 800;
  const chartWidth = Math.max(containerWidth, periods.length * 52 + 100);
  chart.style.width = `${chartWidth}px`;
  chart.setAttribute("viewBox", `0 0 ${chartWidth} ${CHART_HEIGHT}`);
  chart.replaceChildren();
  elements["flow-legend"].replaceChildren();
  chart.setAttribute("aria-label", "Стовпчиковий графік періодів заряду та розряду батареї");

  if (periods.length === 0) {
    const empty = svgElement("text", {
      class: "chart-empty",
      x: chartWidth / 2,
      y: 126,
      "text-anchor": "middle",
    });
    empty.textContent = "Періоди заряду й розряду з’являться після вимірювань";
    chart.append(empty);
    return;
  }

  const bounds = { left: 72, right: chartWidth - 18, top: 22, bottom: 206 };
  const maxEnergy = periods.reduce(
    (maximum, period) => Math.max(maximum, period.energyKwh || 0),
    0,
  );
  const energyRange = Math.max(0.001, Math.ceil(maxEnergy * 1.1 * 1000) / 1000);
  const zeroY = (bounds.top + bounds.bottom) / 2;
  const y = (energy) =>
    zeroY - (energy / energyRange) * ((bounds.bottom - bounds.top) / 2);

  for (let tick = -2; tick <= 2; tick += 1) {
    const value = (energyRange * tick) / 2;
    const lineY = y(value);
    chart.append(
      svgElement("line", {
        class: tick === 0 ? "flow-zero-line" : "chart-grid-line",
        x1: bounds.left,
        x2: bounds.right,
        y1: lineY,
        y2: lineY,
      }),
    );
    const label = svgElement("text", {
      class: "chart-axis-label",
      x: bounds.left - 10,
      y: lineY + 3,
      "text-anchor": "end",
    });
    label.textContent = `${value.toFixed(energyRange < 0.01 ? 4 : 3)} kWh`;
    chart.append(label);
  }

  const groupWidth = (bounds.right - bounds.left) / periods.length;
  const barWidth = Math.min(30, groupWidth * 0.62);
  const labelEvery = Math.max(1, Math.ceil(100 / groupWidth));
  periods.forEach((period, index) => {
    const energy = period.energyKwh || 0;
    const signedEnergy = period.direction === "charge" ? energy : -energy;
    const barY = Math.min(zeroY, y(signedEnergy));
    const barHeight = Math.max(1, Math.abs(y(signedEnergy) - zeroY));
    const bar = svgElement("rect", {
      class: `flow-bar flow-${period.direction}-bar`,
      x: bounds.left + groupWidth * (index + 0.5) - barWidth / 2,
      y: barY,
      width: barWidth,
      height: barHeight,
      rx: 2,
    });
    const title = svgElement("title");
    title.textContent = [
      period.direction === "charge" ? "Заряджання" : "Розряджання",
      `${formatFlowTimestamp(period.startTimestamp)} – ${formatFlowTimestamp(period.endTimestamp)}`,
      `Час: ${formatFlowDuration(period.activeDurationMs)}`,
      `SOC: ${formatFlowSoc(period)}`,
      `Енергія: ${Number.isFinite(period.energyKwh) ? `${period.energyKwh.toFixed(3)} kWh` : "—"}`,
      `Середня напруга: ${Number.isFinite(period.averageVoltage) ? `${period.averageVoltage.toFixed(1)} V` : "—"}`,
      `Струм: ${period.minCurrent.toFixed(1)}–${period.maxCurrent.toFixed(1)} A`,
    ].join("\n");
    bar.append(title);
    chart.append(bar);

    if (index % labelEvery === 0 || index === periods.length - 1) {
      const label = svgElement("text", {
        class: "chart-x-label",
        x: bounds.left + groupWidth * (index + 0.5),
        y: bounds.bottom + 22,
        "text-anchor": "middle",
      });
      label.textContent = new Date(period.startTimestamp).toLocaleString("uk-UA", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      chart.append(label);
    }
  });

  const axisTitle = svgElement("text", {
    class: "chart-x-label",
    x: (bounds.left + bounds.right) / 2,
    y: 249,
    "text-anchor": "middle",
  });
  axisTitle.textContent = "Періоди заряду та розряду · енергія, kWh";
  chart.append(axisTitle);

  for (const [label, color] of [
    ["Заряджання (+)", "#b7f36a"],
    ["Розряджання (−)", "#ff9770"],
  ]) {
    const legendItem = document.createElement("span");
    const swatch = document.createElement("i");
    const legendLabel = document.createElement("span");
    legendItem.className = "chart-legend-item";
    swatch.className = "chart-legend-swatch";
    swatch.style.backgroundColor = color;
    legendLabel.textContent = label;
    legendItem.append(swatch, legendLabel);
    elements["flow-legend"].append(legendItem);
  }

  chart.setAttribute(
    "aria-label",
    `Стовпчики показують енергію в kWh за ${periods.length} періодів заряду та розряду.`,
  );
}

function svgElement(tagName, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tagName);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function saveCurrentMeasurement() {
  if (!latestMeasurement || !settings || !measurementStorageKey) return;
  const timestamp = Date.parse(latestMeasurement.timestamp);
  if (timestamp - lastSavedAt < SAMPLE_INTERVAL_MS) return;

  const snapshot = {
    ...latestMeasurement,
    cellCount: settings.cellCount,
    model: elements["model-value"].textContent,
  };
  const nextMeasurements = [...measurements, snapshot].slice(-MAX_SAMPLES);

  try {
    localStorage.setItem(measurementStorageKey, JSON.stringify(nextMeasurements));
    measurements = nextMeasurements;
    lastSavedAt = timestamp;
    measurementStorageWarningShown = false;
    renderLogSummary();
  } catch (error) {
    if (!measurementStorageWarningShown) {
      showNotice(`Не вдалося зберегти журнал у браузері: ${error.message}`, "error");
      measurementStorageWarningShown = true;
    }
  }
}

function loadMeasurements(storageKey) {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored && storageKey !== LOG_STORAGE_KEY && localStorage.getItem(LOG_STORAGE_KEY)) {
      if (!legacyLogNoticeShown) {
        storageWarnings.push(
          "Знайдено старий спільний журнал без ідентифікатора BMS; нові вимірювання зберігатимуться окремо.",
        );
        legacyLogNoticeShown = true;
      }
    }
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (entry) =>
          entry &&
          typeof entry === "object" &&
          !Array.isArray(entry) &&
          typeof entry.timestamp === "string" &&
          Number.isFinite(Date.parse(entry.timestamp)) &&
          Array.isArray(entry.cellVoltages),
      )
    ) {
      throw new Error("Неправильний формат журналу вимірювань.");
    }
    return parsed.slice(-MAX_SAMPLES);
  } catch (error) {
    storageErrors.push(`Не вдалося прочитати локальний журнал: ${error.message}`);
    return [];
  }
}

function loadFlowSamples(storagePrefix) {
  try {
    const rawChunks = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key?.startsWith(storagePrefix)) {
        rawChunks.push({ key, raw: localStorage.getItem(key) });
      }
    }

    const { samples, errors } = parseFlowChunkEntries(rawChunks, storagePrefix);
    if (errors.length > 0) {
      storageErrors.push(
        `Частину історії струму цієї BMS не вдалося прочитати (${errors.length} блок.).`,
      );
    }
    return samples;
  } catch (error) {
    storageErrors.push(`Не вдалося прочитати історію струму цієї BMS: ${error.message}`);
    return [];
  }
}

function enrichFlowSamples(samples, storedMeasurements) {
  const timedMeasurements = storedMeasurements
    .map((measurement) => ({
      timestamp: Date.parse(measurement.timestamp),
      voltage: measurement.voltage,
      power: measurement.power,
      stateOfCharge: measurement.stateOfCharge,
    }))
    .filter((measurement) => Number.isFinite(measurement.timestamp))
    .sort((first, second) => first.timestamp - second.timestamp);

  if (timedMeasurements.length === 0) return samples;

  return samples.map((sample) => {
    if (
      Number.isFinite(sample.voltage) &&
      Number.isFinite(sample.power) &&
      Number.isFinite(sample.stateOfCharge)
    ) {
      return sample;
    }

    let low = 0;
    let high = timedMeasurements.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (timedMeasurements[middle].timestamp < sample.timestamp) low = middle + 1;
      else high = middle;
    }
    const candidates = [timedMeasurements[low - 1], timedMeasurements[low]].filter(Boolean);
    const nearest = candidates.reduce(
      (best, measurement) =>
        !best || Math.abs(measurement.timestamp - sample.timestamp) <
          Math.abs(best.timestamp - sample.timestamp)
          ? measurement
          : best,
      undefined,
    );
    if (!nearest || Math.abs(nearest.timestamp - sample.timestamp) > 10_000) return sample;

    return {
      ...sample,
      voltage: Number.isFinite(sample.voltage) ? sample.voltage : nearest.voltage,
      power: Number.isFinite(sample.power) ? sample.power : nearest.power,
      stateOfCharge: Number.isFinite(sample.stateOfCharge)
        ? sample.stateOfCharge
        : nearest.stateOfCharge,
    };
  });
}

function renderLogSummary() {
  elements["log-count"].textContent = String(measurements.length);
  elements["export-button"].disabled = measurements.length === 0;
  elements["clear-logs-button"].disabled = measurements.length === 0;
  elements["last-log"].textContent = measurements.length
    ? `Останній запис: ${new Date(measurements.at(-1).timestamp).toLocaleString("uk-UA")}`
    : "Дані ще не записувалися";
}

function getDeviceStorageId(connectedDevice) {
  if (typeof connectedDevice.id === "string" && connectedDevice.id.length > 0) {
    return connectedDevice.id;
  }
  if (typeof connectedDevice.name === "string" && connectedDevice.name.length > 0) {
    return `name:${connectedDevice.name}`;
  }
  throw new Error("Bluetooth-пристрій не має сталого ID або назви для окремого збереження даних.");
}

function makeDeviceStorageKey(baseKey, deviceId) {
  return `${baseKey}.${encodeURIComponent(deviceId)}`;
}

function recordRecentDevice(connectedDevice, selectedDesktopDevice = null) {
  const recentId =
    typeof selectedDesktopDevice?.id === "string" && selectedDesktopDevice.id.length > 0
      ? selectedDesktopDevice.id
      : connectedDevice.id;
  if (typeof recentId !== "string" || recentId.length === 0) return;
  const recentName = selectedDesktopDevice?.name || connectedDevice.name || "JK BMS";

  try {
    const stored = JSON.parse(localStorage.getItem(BLUETOOTH_PREFERENCES_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new Error("Некоректний формат списку Bluetooth-пристроїв.");
    }
    const recent = Array.isArray(stored.recent)
      ? stored.recent.filter((entry) => entry && typeof entry.id === "string")
      : [];
    recent.unshift({
      id: recentId,
      name: recentName,
      connectedAt: new Date().toISOString(),
    });
    const seenIds = new Set();
    const uniqueRecent = recent
      .filter((entry) => {
        if (seenIds.has(entry.id)) return false;
        seenIds.add(entry.id);
        return true;
      })
      .slice(0, 20);
    localStorage.setItem(
      BLUETOOTH_PREFERENCES_KEY,
      JSON.stringify({
        favorites: Array.isArray(stored.favorites)
          ? stored.favorites.filter((id) => typeof id === "string")
          : [],
        recent: uniqueRecent,
      }),
    );
  } catch (error) {
    showNotice(`Не вдалося зберегти останнє підключення: ${error.message}`, "error");
  }
}

function setupDashboardLayout() {
  const dashboard = elements["dashboard-grid"];
  const widgets = [...dashboard.querySelectorAll(":scope > [data-widget]")];
  const defaultOrder = widgets.map((widget) => widget.dataset.widget);
  const widgetById = new Map(widgets.map((widget) => [widget.dataset.widget, widget]));
  const defaultColumns = {
    soc: 1,
    voltage: 1,
    current: 1,
    power: 1,
    forecast: 2,
    "charge-forecast": 2,
    flow: 2,
    cells: 3,
    status: 1,
    logs: 4,
    alarms: 2,
  };
  const minimumHeights = {
    soc: 120,
    voltage: 120,
    current: 120,
    power: 120,
    forecast: 140,
    "charge-forecast": 140,
    flow: 240,
    cells: 240,
    status: 200,
    logs: 100,
    alarms: 160,
  };
  const sizePreferences = new Map(
    widgets.map((widget) => [
      widget.dataset.widget,
      { columns: defaultColumns[widget.dataset.widget] ?? 1, minHeight: undefined },
    ]),
  );
  let draggedWidget;
  let dragStartOrder;
  let dragStartRects;

  for (const widget of widgets) {
    const title =
      widget.querySelector(".metric-heading > span, .panel-heading h2")?.textContent.trim() ??
      widget.dataset.widget;
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "widget-handle";
    handle.textContent = "⠿";
    handle.draggable = false;
    handle.hidden = true;
    handle.setAttribute("aria-label", `Перетягнути блок: ${title}`);
    handle.title = "Перетягни або скористайся стрілками клавіатури";
    widget.append(handle);

    const resizeHandle = document.createElement("button");
    resizeHandle.type = "button";
    resizeHandle.className = "widget-resize-handle";
    resizeHandle.textContent = "⤡";
    resizeHandle.hidden = true;
    resizeHandle.setAttribute("aria-label", `Змінити розмір блоку: ${title}`);
    resizeHandle.title = "Перетягни для зміни ширини й висоти; стрілки клавіатури також працюють";
    widget.append(resizeHandle);

    handle.addEventListener("keydown", (event) => {
      if (!dashboard.classList.contains("layout-editing")) return;
      const currentIndex = [...dashboard.children].indexOf(widget);
      if ((event.key === "ArrowLeft" || event.key === "ArrowUp") && currentIndex > 0) {
        event.preventDefault();
        const firstRects = captureWidgetRects();
        dashboard.insertBefore(widget, widget.previousElementSibling);
        animateDashboardLayout(firstRects);
        saveDashboardLayout();
      } else if (
        (event.key === "ArrowRight" || event.key === "ArrowDown") &&
        currentIndex < dashboard.children.length - 1
      ) {
        event.preventDefault();
        const firstRects = captureWidgetRects();
        dashboard.insertBefore(widget.nextElementSibling, widget);
        animateDashboardLayout(firstRects);
        saveDashboardLayout();
      }
    });

    handle.addEventListener("dragstart", (event) => {
      if (!dashboard.classList.contains("layout-editing")) {
        event.preventDefault();
        return;
      }
      draggedWidget = widget;
      dragStartOrder = getDashboardOrder();
      dragStartRects = captureWidgetRects();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", widget.dataset.widget);
      widget.classList.add("is-dragging");
    });

    handle.addEventListener("dragend", () => {
      widget.classList.remove("is-dragging");
      for (const item of widgets) item.classList.remove("drop-before", "drop-after");
      if (dragStartOrder && !sameOrder(dragStartOrder, getDashboardOrder())) {
        animateDashboardLayout(dragStartRects);
        saveDashboardLayout();
      }
      draggedWidget = undefined;
      dragStartOrder = undefined;
      dragStartRects = undefined;
    });

    resizeHandle.addEventListener("keydown", (event) => {
      if (!dashboard.classList.contains("layout-editing")) return;
      const direction = {
        ArrowLeft: { columns: -1 },
        ArrowRight: { columns: 1 },
        ArrowUp: { height: -16 },
        ArrowDown: { height: 16 },
      }[event.key];
      if (!direction) return;

      event.preventDefault();
      const firstRects = captureWidgetRects();
      const size = sizePreferences.get(widget.dataset.widget);
      if (direction.columns) {
        size.columns = Math.max(1, Math.min(getGridColumnCount(), size.columns + direction.columns));
      } else {
        const currentHeight = size.minHeight ?? widget.getBoundingClientRect().height;
        size.minHeight = Math.max(
          minimumHeights[widget.dataset.widget] ?? 100,
          Math.min(1200, currentHeight + direction.height),
        );
      }
      applyWidgetSize(widget);
      animateDashboardLayout(firstRects);
      saveDashboardLayout();
    });

    let resizeState;
    resizeHandle.addEventListener("pointerdown", (event) => {
      if (!dashboard.classList.contains("layout-editing") || event.button !== 0) return;
      event.preventDefault();
      resizeHandle.setPointerCapture(event.pointerId);
      const rect = widget.getBoundingClientRect();
      const gridColumns = getGridColumnCount();
      const gap = Number.parseFloat(getComputedStyle(dashboard).columnGap) || 0;
      resizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startColumns: sizePreferences.get(widget.dataset.widget).columns,
        startHeight: rect.height,
        trackWidth: (dashboard.clientWidth - gap * (gridColumns - 1)) / gridColumns,
        firstRects: captureWidgetRects(),
      };
      widget.classList.add("is-resizing");
    });

    resizeHandle.addEventListener("pointermove", (event) => {
      if (!resizeState || event.pointerId !== resizeState.pointerId) return;
      const size = sizePreferences.get(widget.dataset.widget);
      const gridColumns = getGridColumnCount();
      size.columns = Math.max(
        1,
        Math.min(
          gridColumns,
          resizeState.startColumns +
            Math.round((event.clientX - resizeState.startX) / resizeState.trackWidth),
        ),
      );
      size.minHeight = Math.max(
        minimumHeights[widget.dataset.widget] ?? 100,
        Math.min(1200, resizeState.startHeight + event.clientY - resizeState.startY),
      );
      applyWidgetSize(widget);
    });

    const finishResize = (event) => {
      if (!resizeState || event.pointerId !== resizeState.pointerId) return;
      const firstRects = resizeState.firstRects;
      resizeState = undefined;
      widget.classList.remove("is-resizing");
      animateDashboardLayout(firstRects);
      saveDashboardLayout();
    };
    resizeHandle.addEventListener("pointerup", finishResize);
    resizeHandle.addEventListener("pointercancel", finishResize);
  }

  dashboard.addEventListener("dragover", (event) => {
    if (!draggedWidget || !(event.target instanceof Element)) return;
    const target = event.target.closest("[data-widget]");
    if (!target || target === draggedWidget || target.parentElement !== dashboard) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";

    const bounds = target.getBoundingClientRect();
    const midpointY = bounds.top + bounds.height / 2;
    const midpointX = bounds.left + bounds.width / 2;
    const horizontalDistance = Math.abs(event.clientX - midpointX) / bounds.width;
    const verticalDistance = Math.abs(event.clientY - midpointY) / bounds.height;
    const before =
      horizontalDistance > verticalDistance
        ? event.clientX < midpointX
        : event.clientY < midpointY;
    for (const item of widgets) item.classList.remove("drop-before", "drop-after");

    if (before) {
      target.classList.add("drop-before");
      if (draggedWidget.nextElementSibling !== target) {
        const firstRects = captureWidgetRects();
        dashboard.insertBefore(draggedWidget, target);
        animateDashboardLayout(firstRects);
      }
    } else {
      target.classList.add("drop-after");
      if (target.nextElementSibling !== draggedWidget) {
        const firstRects = captureWidgetRects();
        dashboard.insertBefore(draggedWidget, target.nextElementSibling);
        animateDashboardLayout(firstRects);
      }
    }
  });

  dashboard.addEventListener("drop", (event) => {
    if (draggedWidget) event.preventDefault();
  });

  elements["layout-toggle"].addEventListener("click", () => {
    const editing = elements["layout-toggle"].getAttribute("aria-pressed") !== "true";
    elements["layout-toggle"].setAttribute("aria-pressed", String(editing));
    elements["layout-toggle"].replaceChildren();
    const icon = document.createElement("span");
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = editing ? "✓" : "▦";
    elements["layout-toggle"].append(icon);
    elements["layout-toggle"].dataset.tooltip = editing
      ? "Завершити компонування"
      : "Компонування блоків";
    elements["layout-toggle"].setAttribute(
      "aria-label",
      editing ? "Завершити компонування блоків" : "Увімкнути компонування блоків",
    );
    elements["layout-reset"].hidden = !editing;
    if (editing) {
      showNotice(
        "Перетягни блок за ⠿, зміни розмір за кутовий маркер або скористайся стрілками клавіатури.",
        "info",
        { key: "layout-hint", duration: 6000 },
      );
    } else {
      dismissNotice("layout-hint");
    }
    dashboard.classList.toggle("layout-editing", editing);
    for (const handle of dashboard.querySelectorAll(".widget-handle, .widget-resize-handle")) {
      handle.hidden = !editing;
      if (handle.classList.contains("widget-handle")) handle.draggable = editing;
    }
    if (editing) dashboard.querySelector(".widget-handle")?.focus();
  });

  elements["layout-reset"].addEventListener("click", () => {
    const firstRects = captureWidgetRects();
    for (const widgetId of defaultOrder) {
      const widget = widgetById.get(widgetId);
      if (widget) dashboard.append(widget);
    }
    for (const widget of widgets) {
      sizePreferences.set(widget.dataset.widget, {
        columns: defaultColumns[widget.dataset.widget] ?? 1,
        minHeight: undefined,
      });
      applyWidgetSize(widget);
    }
    animateDashboardLayout(firstRects);
    try {
      localStorage.removeItem(DASHBOARD_LAYOUT_KEY);
      showNotice("Початкове розташування блоків відновлено.");
    } catch (error) {
      showNotice(`Не вдалося скинути збережене розташування: ${error.message}`, "error");
    }
  });

  try {
    const storedLayout = JSON.parse(localStorage.getItem(DASHBOARD_LAYOUT_KEY) || "null");
    const storedOrder = Array.isArray(storedLayout) ? storedLayout : storedLayout?.order;
    const storedSizes =
      !Array.isArray(storedLayout) && storedLayout?.sizes && typeof storedLayout.sizes === "object"
        ? storedLayout.sizes
        : {};
    if (Array.isArray(storedOrder)) {
      const orderedIds = [...new Set(storedOrder.filter((id) => widgetById.has(id)))];
      for (const widgetId of [...orderedIds, ...defaultOrder.filter((id) => !orderedIds.includes(id))]) {
        dashboard.append(widgetById.get(widgetId));
      }
    }
    for (const widget of widgets) {
      const savedSize = storedSizes[widget.dataset.widget];
      if (!savedSize || typeof savedSize !== "object") continue;
      const size = sizePreferences.get(widget.dataset.widget);
      if (Number.isInteger(savedSize.columns)) {
        size.columns = Math.max(1, Math.min(4, savedSize.columns));
      }
      if (Number.isFinite(savedSize.minHeight)) {
        size.minHeight = Math.max(100, Math.min(1200, savedSize.minHeight));
      }
    }
  } catch (error) {
    showNotice(`Не вдалося відновити розташування блоків: ${error.message}`, "error");
  }
  for (const widget of widgets) applyWidgetSize(widget);
  const contentResizeObserver = new ResizeObserver((entries) => {
    const changedWidgets = new Set(
      entries.map((entry) => entry.target.closest("[data-widget]")).filter(Boolean),
    );
    for (const widget of changedWidgets) applyWidgetSize(widget);
  });
  for (const widget of widgets) {
    for (const child of widget.children) contentResizeObserver.observe(child);
  }
  window.addEventListener("resize", () => {
    for (const widget of widgets) applyWidgetSize(widget);
  });

  function getDashboardOrder() {
    return [...dashboard.children].map((widget) => widget.dataset.widget);
  }

  function getGridColumnCount() {
    const columnCount = Number.parseInt(
      getComputedStyle(dashboard).getPropertyValue("--dashboard-columns"),
      10,
    );
    return Number.isInteger(columnCount) && columnCount > 0 ? columnCount : 4;
  }

  function applyWidgetSize(widget) {
    const size = sizePreferences.get(widget.dataset.widget);
    widget.style.gridColumn = `span ${Math.min(size.columns, getGridColumnCount())}`;
    widget.style.removeProperty("grid-row-end");
    if (size.minHeight === undefined) {
      widget.style.removeProperty("--widget-min-height");
    } else {
      widget.style.setProperty("--widget-min-height", `${size.minHeight}px`);
    }
    const gridStyle = getComputedStyle(dashboard);
    const rowHeight = Number.parseFloat(gridStyle.gridAutoRows);
    const rowGap = Number.parseFloat(gridStyle.rowGap);
    if (!Number.isFinite(rowHeight) || !Number.isFinite(rowGap) || rowHeight + rowGap <= 0) {
      return;
    }
    const widgetHeight = Math.max(widget.scrollHeight, widget.getBoundingClientRect().height);
    const rowSpan = Math.max(1, Math.ceil((widgetHeight + rowGap) / (rowHeight + rowGap)));
    widget.style.gridRowEnd = `span ${rowSpan}`;
  }

  function captureWidgetRects() {
    return new Map(
      widgets.map((widget) => {
        const rect = widget.getBoundingClientRect();
        return [widget, { left: rect.left, top: rect.top }];
      }),
    );
  }

  function animateDashboardLayout(firstRects) {
    if (!firstRects || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const movingWidgets = [];
    for (const widget of widgets) {
      const first = firstRects.get(widget);
      if (!first) continue;

      widget.classList.remove("is-flipping");
      widget.style.removeProperty("transform");
      widget.style.removeProperty("transition");
      const last = widget.getBoundingClientRect();
      const deltaX = first.left - last.left;
      const deltaY = first.top - last.top;
      if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) continue;

      widget.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
      movingWidgets.push(widget);
    }

    if (movingWidgets.length === 0) return;

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        for (const widget of movingWidgets) {
          widget.classList.add("is-flipping");
          widget.style.transform = "translate(0, 0)";
          const onTransitionEnd = (event) => {
            if (event.target !== widget || event.propertyName !== "transform") return;
            widget.removeEventListener("transitionend", onTransitionEnd);
            widget.classList.remove("is-flipping");
            widget.style.removeProperty("transform");
          };
          widget.addEventListener("transitionend", onTransitionEnd);
        }
      });
    });
  }

  function sameOrder(first, second) {
    return first.length === second.length && first.every((widget, index) => widget === second[index]);
  }

  function saveDashboardLayout() {
    try {
      localStorage.setItem(
        DASHBOARD_LAYOUT_KEY,
        JSON.stringify({
          order: getDashboardOrder(),
          sizes: Object.fromEntries(sizePreferences),
        }),
      );
    } catch (error) {
      showNotice(`Не вдалося зберегти розташування блоків: ${error.message}`, "error");
    }
  }
}

function exportCsv() {
  if (measurements.length === 0) return;
  const headers = [
    "timestamp",
    "model",
    "cell_count",
    "soc_percent",
    "voltage_v",
    "current_a",
    "power_w",
    "remaining_capacity_ah",
    "average_cell_voltage_v",
    "cell_voltage_delta_v",
    "balance_current_a",
    "temperature_1_c",
    "temperature_2_c",
    "mos_temperature_c",
    "cycle_count",
    "cell_voltages_v",
  ];
  const rows = measurements.map((entry) =>
    [
      entry.timestamp,
      entry.model,
      entry.cellCount,
      entry.stateOfCharge,
      entry.voltage,
      entry.current,
      entry.power,
      entry.remainingCapacity,
      entry.averageCellVoltage,
      entry.cellVoltageDelta,
      entry.balanceCurrent,
      entry.temperature1,
      entry.temperature2,
      entry.mosTemperature,
      entry.cycleCount,
      entry.cellVoltages.join("|"),
    ]
      .map(csvCell)
      .join(","),
  );
  const blob = new Blob(["\uFEFF", [headers.join(","), ...rows].join("\r\n")], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `jk-bms-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function clearLogs() {
  if (!measurementStorageKey) return;
  if (!window.confirm("Видалити вимірювання лише для цієї BMS?")) return;
  try {
    localStorage.removeItem(measurementStorageKey);
    measurements = [];
    lastSavedAt = Date.parse(latestMeasurement?.timestamp) || 0;
    renderLogSummary();
    showNotice("Журнал вимірювань цієї BMS очищено.");
  } catch (error) {
    showNotice(`Не вдалося очистити журнал: ${error.message}`, "error");
  }
}

function csvCell(value) {
  return formatCsvCell(value);
}

function handleDisconnect() {
  recordFlowConnectionEnd();
  persistFlowChunk();
  if (sampleTimer) window.clearInterval(sampleTimer);
  sampleTimer = undefined;
  if (notifyCharacteristic) {
    notifyCharacteristic.removeEventListener("characteristicvaluechanged", handleNotification);
    notifyCharacteristic = undefined;
  }
  writeCharacteristic = undefined;
  dismissNotice("protocol-detect");
  setConnectionState("Не підключено", false);
  elements["connect-button"].disabled = false;
  elements["connect-button"].hidden = false;
  elements["disconnect-button"].disabled = true;
  elements["disconnect-button"].hidden = true;
  elements["refresh-button"].disabled = true;
  elements["refresh-button"].hidden = true;
  renderDischargeForecast({ status: "disconnected" });
  renderChargeForecast({ status: "disconnected" });
  showNotice("З’єднання з BMS завершено.");
}

function disconnect() {
  if (device?.gatt?.connected) {
    device.gatt.disconnect();
  } else {
    handleDisconnect();
  }
}

function setConnectionState(label, connected) {
  elements["connection-state"].textContent = label;
  elements["connection-indicator"].classList.toggle("is-connected", connected);
}

function dismissNotice(key) {
  const entry = activeToasts.get(key);
  if (!entry) return;
  activeToasts.delete(key);
  if (entry.timer) window.clearTimeout(entry.timer);
  entry.element.classList.add("is-leaving");
  window.setTimeout(() => entry.element.remove(), 180);
}

function showNotice(message, kind = "info", options = {}) {
  const container = elements["toast-container"];
  if (!container) return;

  const {
    key,
    duration = kind === "error" ? 8000 : 5000,
    persistent = false,
    action,
    dismissible = persistent,
    onDismiss,
  } = options;

  let entry = key ? activeToasts.get(key) : undefined;
  let toast;
  if (entry) {
    if (entry.timer) window.clearTimeout(entry.timer);
    entry.timer = undefined;
    toast = entry.element;
    toast.classList.remove("is-leaving");
    toast.replaceChildren();
  } else {
    toast = document.createElement("div");
    toast.className = "notice";
    container.append(toast);
    entry = { element: toast, timer: undefined };
    if (key) activeToasts.set(key, entry);
  }

  toast.dataset.kind = kind;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");

  const text = document.createElement("span");
  text.className = "notice-message";
  text.textContent = message;
  toast.append(text);

  const removeToast = (notifyDismiss = false) => {
    if (key && activeToasts.get(key) === entry) {
      activeToasts.delete(key);
    }
    if (entry.timer) window.clearTimeout(entry.timer);
    entry.timer = undefined;
    toast.classList.add("is-leaving");
    window.setTimeout(() => toast.remove(), 180);
    if (notifyDismiss) onDismiss?.();
  };

  if (action || dismissible) {
    const actions = document.createElement("div");
    actions.className = "notice-actions";
    if (action) {
      const button = document.createElement("button");
      button.className = "notice-action";
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => action.onClick());
      actions.append(button);
    }
    if (dismissible) {
      const closeButton = document.createElement("button");
      closeButton.className = "notice-dismiss";
      closeButton.type = "button";
      closeButton.setAttribute("aria-label", "Закрити повідомлення");
      closeButton.textContent = "×";
      closeButton.addEventListener("click", () => removeToast(true));
      actions.append(closeButton);
    }
    toast.append(actions);
  }

  if (!persistent && duration > 0) {
    entry.timer = window.setTimeout(() => removeToast(false), duration);
  }
}

function format(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}
