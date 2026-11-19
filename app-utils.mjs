import { FLOW_CURRENT_DEADBAND_A } from "./flow-periods.mjs";

export const FLOW_CURRENT_CHANGE_THRESHOLD_A = 0.5;
export const FLOW_IDLE_SAMPLE_INTERVAL_MS = 60 * 1000;

export function formatCsvCell(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `"${String(value)}"`;
  }
  const text = String(value ?? "");
  const safeText = /^[\t\r ]*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safeText.replaceAll('"', '""')}"`;
}

export function minMaxValues(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }
  return { min, max };
}

export function flowDirectionOf(current, deadbandA = FLOW_CURRENT_DEADBAND_A) {
  if (current > deadbandA) return "charge";
  if (current < -deadbandA) return "discharge";
  return "idle";
}

export function shouldRecordFlowSample({
  current,
  previousCurrent,
  timestamp,
  lastSampleAt,
  sampleIntervalMs,
  deadbandA = FLOW_CURRENT_DEADBAND_A,
  minDeltaA = FLOW_CURRENT_CHANGE_THRESHOLD_A,
  idleIntervalMs = FLOW_IDLE_SAMPLE_INTERVAL_MS,
}) {
  if (!Number.isFinite(current) || !Number.isFinite(timestamp)) return false;
  if (previousCurrent === undefined || lastSampleAt === undefined) return true;

  const previousDirection = flowDirectionOf(previousCurrent, deadbandA);
  const currentDirection = flowDirectionOf(current, deadbandA);
  if (currentDirection !== previousDirection) return true;

  if (Math.abs(current - previousCurrent) >= minDeltaA) return true;

  const elapsed = timestamp - lastSampleAt;
  if (currentDirection === "idle") {
    return elapsed >= idleIntervalMs;
  }
  return elapsed >= sampleIntervalMs;
}

export function parseFlowChunkEntries(rawChunks, storagePrefix) {
  const samples = [];
  const errors = [];

  for (const { key, raw } of rawChunks) {
    try {
      const suffix = key.slice(storagePrefix.length);
      const separator = suffix.lastIndexOf(".");
      if (separator <= 0) throw new Error(`Некоректний ключ історії: ${key}`);
      const sessionId = suffix.slice(0, separator);
      const chunk = JSON.parse(raw || "null");
      if (!Array.isArray(chunk)) throw new Error(`Некоректний блок історії: ${key}`);

      const chunkSamples = [];
      for (const entry of chunk) {
        if (
          !Array.isArray(entry) ||
          ![2, 5, 6].includes(entry.length) ||
          !Number.isFinite(entry[0]) ||
          !Number.isFinite(entry[1]) ||
          (entry.length >= 5 &&
            !entry.slice(2, 5).every((value) => value === null || Number.isFinite(value))) ||
          (entry.length === 6 && entry[5] !== "connection-end")
        ) {
          throw new Error(`Некоректний запис у блоці історії: ${key}`);
        }
        chunkSamples.push({
          timestamp: entry[0],
          current: entry[1],
          voltage: entry.length >= 5 ? entry[2] : undefined,
          power: entry.length >= 5 ? entry[3] : undefined,
          stateOfCharge: entry.length >= 5 ? entry[4] : undefined,
          sessionId,
          kind: entry.length === 6 ? entry[5] : undefined,
        });
      }
      samples.push(...chunkSamples);
    } catch (error) {
      errors.push(error.message);
    }
  }

  samples.sort((first, second) => first.timestamp - second.timestamp);
  return { samples, errors };
}

export function selectChunksToEvict(chunkSummaries, maxChunks, protectedKey) {
  if (chunkSummaries.length <= maxChunks) return [];
  const sorted = [...chunkSummaries]
    .filter((chunk) => chunk.key !== protectedKey)
    .sort((first, second) => first.oldestTimestamp - second.oldestTimestamp);
  const removeCount = Math.max(0, chunkSummaries.length - maxChunks);
  return sorted.slice(0, removeCount).map((chunk) => chunk.key);
}

export function resolveRecentDevices(recentEntries, visibleDevices) {
  const devicesById = new Map(visibleDevices.map((device) => [device.deviceId, device]));
  const devicesByName = new Map();
  for (const device of visibleDevices) {
    const normalizedName = (device.deviceName || "").trim().toLocaleLowerCase();
    if (!normalizedName) continue;
    if (!devicesByName.has(normalizedName)) {
      devicesByName.set(normalizedName, []);
    }
    devicesByName.get(normalizedName).push(device);
  }

  const matched = [];
  const seenIds = new Set();
  for (const entry of recentEntries) {
    let device = devicesById.get(entry.id);
    if (!device && typeof entry.name === "string") {
      const normalizedName = entry.name.trim().toLocaleLowerCase();
      const candidates = normalizedName ? devicesByName.get(normalizedName) : undefined;
      if (candidates?.length === 1) {
        device = candidates[0];
      }
    }
    if (!device || seenIds.has(device.deviceId)) continue;
    seenIds.add(device.deviceId);
    matched.push(device);
  }
  return matched;
}
