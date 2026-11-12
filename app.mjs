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

const LOG_STORAGE_KEY = "jk-bms-monitor.measurements.v1";
const DASHBOARD_LAYOUT_KEY = "jk-bms-monitor.dashboard-layout.v1";
const MAX_SAMPLES = 2000;
const SAMPLE_INTERVAL_MS = 5000;
const CHART_SAMPLE_INTERVAL_MS = 1000;
const CHART_HISTORY_MS = 5 * 60 * 1000;
const MAX_CHART_SAMPLES = 300;
const CHART_HEIGHT = 260;
const elements = Object.fromEntries(
  [
    "connection-indicator",
    "connection-state",
    "dashboard-grid",
    "layout-toggle",
    "layout-reset",
    "layout-hint",
    "connect-button",
    "disconnect-button",
    "refresh-button",
    "settings-button",
    "device-summary",
    "notice",
    "soc-value",
    "soc-bar",
    "capacity-value",
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
let writeCharacteristic;
let commandCounter = 0;
let settings;
let protocolVersion;
let latestMeasurement;
let pendingLiveFrame;
let chartSamples = [];
let lastChartSampleAt = 0;
let assembler = new FrameAssembler();
let measurements = loadMeasurements();
let lastSavedAt = 0;
let sampleTimer;
let noticeTimer;

renderLogSummary();
setupDashboardLayout();
renderVoltageChart();
new ResizeObserver(() => renderVoltageChart()).observe(elements["voltage-chart"]);

elements["connect-button"].addEventListener("click", connect);
elements["disconnect-button"].addEventListener("click", disconnect);
elements["refresh-button"].addEventListener("click", requestData);
elements["settings-button"].addEventListener("click", requestData);
elements["export-button"].addEventListener("click", exportCsv);
elements["clear-logs-button"].addEventListener("click", clearLogs);

if (!("bluetooth" in navigator)) {
  showNotice(
    "Цей браузер не підтримує Web Bluetooth. Відкрий застосунок у Chrome або Edge на комп’ютері через localhost чи HTTPS.",
    "error",
  );
  elements["connect-button"].disabled = true;
}

async function connect() {
  elements["connect-button"].disabled = true;
  showNotice("Вибери свою BMS у системному вікні Bluetooth.");

  try {
    device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [SERVICE_UUID],
    });
    settings = undefined;
    protocolVersion = undefined;
    latestMeasurement = undefined;
    pendingLiveFrame = undefined;
    chartSamples = [];
    lastChartSampleAt = 0;
    lastSavedAt = 0;
    resetTelemetry();
    device.addEventListener("gattserverdisconnected", handleDisconnect);
    setConnectionState("Підключення…", false);

    gattServer = await device.gatt.connect();
    const service = await gattServer.getPrimaryService(SERVICE_UUID);
    const characteristics = await service.getCharacteristics(CHARACTERISTIC_UUID);
    const notifyCharacteristic = characteristics.find(
      (characteristic) => characteristic.properties.notify || characteristic.properties.indicate,
    );
    writeCharacteristic = characteristics.find(
      (characteristic) =>
        characteristic.properties.write || characteristic.properties.writeWithoutResponse,
    );

    if (!notifyCharacteristic || !writeCharacteristic) {
      throw new Error("У службі JK BMS не знайдено потрібні BLE-характеристики.");
    }

    assembler = new FrameAssembler();
    notifyCharacteristic.addEventListener("characteristicvaluechanged", handleNotification);
    await notifyCharacteristic.startNotifications();
    setConnectionState("Підключено", true);
    elements["device-summary"].textContent = device.name || "JK BMS через Bluetooth LE";
    elements["disconnect-button"].disabled = false;
    elements["refresh-button"].disabled = false;
    elements["settings-button"].disabled = false;
    showNotice("З’єднання встановлено. Зчитую статус і налаштування.");
    await requestData();
    sampleTimer = window.setInterval(saveCurrentMeasurement, SAMPLE_INTERVAL_MS);
  } catch (error) {
    elements["connect-button"].disabled = false;
    if (error.name === "NotFoundError") {
      clearNotice();
      return;
    }
    if (device?.gatt?.connected) device.gatt.disconnect();
    showNotice(`Не вдалося підключитися: ${error.message}`, "error");
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
      renderSettings();
      elements["settings-button"].textContent = "Оновити дані й статус";
      if (latestMeasurement) {
        renderMeasurement(latestMeasurement);
      }
      if (pendingLiveFrame && protocolVersion) renderPendingLiveData();
      break;
    case 0x02:
      if (!settings || !protocolVersion) {
        pendingLiveFrame = frame;
        showNotice("Отримано дані комірок; визначаю профіль протоколу BMS.");
        return;
      }
      renderLiveData(frame);
      break;
    case 0x03: {
      const info = decodeDeviceInfo(frame);
      protocolVersion = detectProtocolVersion(info, device?.name || "");
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
  latestMeasurement = decodeLiveData(frame, settings.cellCount, protocolVersion);
  renderMeasurement(latestMeasurement);
  recordChartSample(latestMeasurement);
  saveCurrentMeasurement();
}

function renderSettings() {
  elements["settings-cell-count"].textContent = String(settings.cellCount);
  elements["cell-count-label"].textContent = `(${settings.cellCount})`;
  elements["charging-value"].textContent = settings.chargingEnabled ? "Увімкнено" : "Вимкнено";
  elements["discharging-value"].textContent = settings.dischargingEnabled
    ? "Увімкнено"
    : "Вимкнено";
  elements["balancing-value"].textContent = settings.balancingEnabled ? "Увімкнено" : "Вимкнено";
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
  renderCells(measurement.cellVoltages);
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
  ]) {
    elements[id].textContent = "—";
  }
  elements["protection-status"].textContent = "Очікування телеметрії BMS";
  elements["protection-status"].dataset.state = "unknown";
  elements["protection-list"].replaceChildren();
  elements["protection-list"].hidden = true;
  elements["soc-bar"].style.width = "0";
  elements["model-value"].textContent = "Не визначена";
  elements["cells-grid"].innerHTML = '<p class="empty-state">Дані комірок з’являться після підключення.</p>';
  elements["last-update"].textContent = "Очікування даних";
  elements["settings-button"].textContent = "Налаштування доступні після з’єднання";
  renderVoltageChart([]);
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

function renderCells(cellVoltages) {
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
    cell.className = "cell";
    if (voltage === min) cell.classList.add("is-low");
    if (voltage === max) cell.classList.add("is-high");
    label.className = "cell-number";
    label.textContent = `CELL ${String(index + 1).padStart(2, "0")}`;
    value.className = "cell-voltage";
    value.textContent = voltage > 0 ? voltage.toFixed(3) : "—";
    cell.append(label, value);
    fragment.append(cell);
  });

  elements["cells-grid"].replaceChildren(fragment);
}

function recordChartSample(measurement) {
  const timestamp = Date.parse(measurement.timestamp);
  if (timestamp - lastChartSampleAt < CHART_SAMPLE_INTERVAL_MS) return;

  chartSamples.push({ timestamp, cellVoltages: [...measurement.cellVoltages] });
  lastChartSampleAt = timestamp;
  const oldestAllowed = timestamp - CHART_HISTORY_MS;
  chartSamples = chartSamples
    .filter((sample) => sample.timestamp >= oldestAllowed)
    .slice(-MAX_CHART_SAMPLES);
  renderVoltageChart();
}

function renderVoltageChart() {
  const chart = elements["voltage-chart"];
  const namespace = "http://www.w3.org/2000/svg";
  const chartWidth = chart.clientWidth || 800;
  chart.setAttribute("viewBox", `0 0 ${chartWidth} ${CHART_HEIGHT}`);
  chart.replaceChildren();
  elements["chart-legend"].replaceChildren();
  chart.setAttribute("aria-label", "Графік напруги комірок у часі");

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
  const cellCount = Math.max(...chartSamples.map((sample) => sample.cellVoltages.length));
  const voltages = chartSamples.flatMap((sample) => sample.cellVoltages).filter((value) => value > 0);
  if (voltages.length === 0) return;
  const dataMin = Math.min(...voltages);
  const dataMax = Math.max(...voltages);
  const padding = Math.max((dataMax - dataMin) * 0.3, 0.005);
  const minVoltage = Math.floor((dataMin - padding) * 1000) / 1000;
  const maxVoltage = Math.ceil((dataMax + padding) * 1000) / 1000;
  const voltageRange = maxVoltage - minVoltage || 0.01;
  const firstTimestamp = chartSamples[0].timestamp;
  const lastTimestamp = chartSamples.at(-1).timestamp;
  const timeRange = Math.max(lastTimestamp - firstTimestamp, 1000);
  const x = (timestamp) =>
    bounds.left + ((timestamp - firstTimestamp) / timeRange) * (bounds.right - bounds.left);
  const y = (voltage) =>
    bounds.bottom - ((voltage - minVoltage) / voltageRange) * (bounds.bottom - bounds.top);

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

  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const color = `hsl(${(cellIndex * 137.508 + 85) % 360} 68% 70%)`;
    const points = chartSamples
      .map((sample) => ({
        timestamp: sample.timestamp,
        voltage: sample.cellVoltages[cellIndex],
      }))
      .filter(({ voltage }) => Number.isFinite(voltage) && voltage > 0);
    if (points.length === 0) continue;

    const linePath = points
      .map(
        ({ timestamp, voltage }, pointIndex) =>
          `${pointIndex === 0 ? "M" : "L"} ${x(timestamp)} ${y(voltage)}`,
      )
      .join(" ");
    const line = svgElement("path", {
      class: "chart-line",
      d: linePath,
      stroke: color,
    });
    const title = svgElement("title");
    title.textContent = `Комірка ${cellIndex + 1}: ${points.at(-1).voltage.toFixed(3)} V`;
    line.append(title);
    chart.append(line);

    const legendItem = document.createElement("span");
    const swatch = document.createElement("i");
    const label = document.createElement("span");
    legendItem.className = "chart-legend-item";
    swatch.className = "chart-legend-swatch";
    swatch.style.backgroundColor = color;
    label.textContent = `Комірка ${cellIndex + 1}`;
    legendItem.append(swatch, label);
    elements["chart-legend"].append(legendItem);

    const latestPoint = points.at(-1);
    const marker = svgElement("circle", {
      class: "chart-point",
      cx: x(latestPoint.timestamp),
      cy: y(latestPoint.voltage),
      r: 3,
      fill: color,
      stroke: color,
    });
    const markerTitle = svgElement("title");
    markerTitle.textContent = `${formatTime(latestPoint.timestamp)} · комірка ${cellIndex + 1}: ${latestPoint.voltage.toFixed(3)} V`;
    marker.append(markerTitle);
    chart.append(marker);
  }

  chart.setAttribute(
    "aria-label",
    `Історія напруги ${cellCount} комірок за ${Math.round(timeRange / 1000)} секунд. Діапазон: ${dataMin.toFixed(3)}–${dataMax.toFixed(3)} V.`,
  );

  function svgElement(tagName, attributes = {}) {
    const element = document.createElementNS(namespace, tagName);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, String(value));
    }
    return element;
  }
}

function saveCurrentMeasurement() {
  if (!latestMeasurement || !settings) return;
  const timestamp = Date.parse(latestMeasurement.timestamp);
  if (timestamp - lastSavedAt < SAMPLE_INTERVAL_MS) return;
  lastSavedAt = timestamp;

  const snapshot = {
    ...latestMeasurement,
    cellCount: settings.cellCount,
    model: elements["model-value"].textContent,
  };
  const nextMeasurements = [...measurements, snapshot].slice(-MAX_SAMPLES);

  try {
    localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(nextMeasurements));
    measurements = nextMeasurements;
    lastSavedAt = timestamp;
    renderLogSummary();
  } catch (error) {
    showNotice(`Не вдалося зберегти журнал у браузері: ${error.message}`, "error");
  }
}

function loadMeasurements() {
  try {
    const stored = localStorage.getItem(LOG_STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed.slice(-MAX_SAMPLES) : [];
  } catch (error) {
    showNotice(`Не вдалося прочитати локальний журнал: ${error.message}`, "error");
    return [];
  }
}

function renderLogSummary() {
  elements["log-count"].textContent = String(measurements.length);
  elements["export-button"].disabled = measurements.length === 0;
  elements["clear-logs-button"].disabled = measurements.length === 0;
  elements["last-log"].textContent = measurements.length
    ? `Останній запис: ${new Date(measurements.at(-1).timestamp).toLocaleString("uk-UA")}`
    : "Дані ще не записувалися";
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
    cells: 3,
    status: 1,
    settings: 1,
    logs: 4,
    alarms: 2,
  };
  const minimumHeights = {
    soc: 120,
    voltage: 120,
    current: 120,
    power: 120,
    cells: 240,
    status: 200,
    settings: 140,
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
        dashboard.insertBefore(draggedWidget, target);
      }
    } else {
      target.classList.add("drop-after");
      if (target.nextElementSibling !== draggedWidget) {
        dashboard.insertBefore(draggedWidget, target.nextElementSibling);
      }
    }
  });

  dashboard.addEventListener("drop", (event) => {
    if (draggedWidget) event.preventDefault();
  });

  elements["layout-toggle"].addEventListener("click", () => {
    const editing = elements["layout-toggle"].getAttribute("aria-pressed") !== "true";
    elements["layout-toggle"].setAttribute("aria-pressed", String(editing));
    elements["layout-toggle"].textContent = editing ? "Готово" : "Розташування";
    elements["layout-toggle"].setAttribute(
      "aria-label",
      editing ? "Завершити компонування блоків" : "Увімкнути компонування блоків",
    );
    elements["layout-reset"].hidden = !editing;
    elements["layout-hint"].hidden = !editing;
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
      widget.style.removeProperty("min-height");
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
  window.addEventListener("resize", () => {
    for (const widget of widgets) applyWidgetSize(widget);
  });

  function getDashboardOrder() {
    return [...dashboard.children].map((widget) => widget.dataset.widget);
  }

  function getGridColumnCount() {
    return getComputedStyle(dashboard).gridTemplateColumns.split(/\s+/).filter(Boolean).length;
  }

  function applyWidgetSize(widget) {
    const size = sizePreferences.get(widget.dataset.widget);
    widget.style.gridColumn = `span ${Math.min(size.columns, getGridColumnCount())}`;
    if (size.minHeight === undefined) {
      widget.style.removeProperty("--widget-min-height");
    } else {
      widget.style.setProperty("--widget-min-height", `${size.minHeight}px`);
    }
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
          widget.addEventListener(
            "transitionend",
            (event) => {
              if (event.propertyName !== "transform") return;
              widget.classList.remove("is-flipping");
              widget.style.removeProperty("transform");
            },
            { once: true },
          );
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
  URL.revokeObjectURL(url);
}

function clearLogs() {
  if (!window.confirm("Видалити всі збережені вимірювання з цього браузера?")) return;
  try {
    localStorage.removeItem(LOG_STORAGE_KEY);
    measurements = [];
    lastSavedAt = Date.parse(latestMeasurement?.timestamp) || 0;
    renderLogSummary();
    showNotice("Локальний журнал очищено.");
  } catch (error) {
    showNotice(`Не вдалося очистити журнал: ${error.message}`, "error");
  }
}

function csvCell(value) {
  const text = String(value ?? "");
  const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

function handleDisconnect() {
  if (sampleTimer) window.clearInterval(sampleTimer);
  sampleTimer = undefined;
  writeCharacteristic = undefined;
  setConnectionState("Не підключено", false);
  elements["connect-button"].disabled = false;
  elements["disconnect-button"].disabled = true;
  elements["refresh-button"].disabled = true;
  elements["settings-button"].disabled = true;
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

function showNotice(message, kind = "info") {
  window.clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.dataset.kind = kind;
  elements.notice.hidden = false;
  if (kind === "info") {
    noticeTimer = window.setTimeout(clearNotice, 6000);
  }
}

function clearNotice() {
  elements.notice.hidden = true;
}

function format(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}
