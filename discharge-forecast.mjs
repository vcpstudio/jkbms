export const DISCHARGE_CURRENT_THRESHOLD_A = 0.1;
export const DISCHARGE_FORECAST_WINDOW_MS = 5 * 60 * 1000;
const MIN_AVERAGE_SPAN_MS = 30 * 1000;

function collectContiguousRecentSamples(validSamples, latestTimestamp, predicate) {
  const windowStart = latestTimestamp - DISCHARGE_FORECAST_WINDOW_MS;
  const recent = [];
  for (let index = validSamples.length - 1; index >= 0; index -= 1) {
    const sample = validSamples[index];
    if (sample.timestamp < windowStart) break;
    if (!predicate(sample)) break;
    recent.push(sample);
  }
  return recent.reverse();
}

export function estimateDischargeRuntime(samples) {
  if (!Array.isArray(samples)) {
    throw new TypeError("Вимірювання споживання мають бути масивом.");
  }
  if (samples.length === 0) return { status: "unavailable" };

  const validSamples = samples
    .filter(({ timestamp, current }) => Number.isFinite(timestamp) && Number.isFinite(current))
    .sort((first, second) => first.timestamp - second.timestamp);
  const latest = validSamples.at(-1);
  if (!latest) return { status: "unavailable" };
  if (latest.current > DISCHARGE_CURRENT_THRESHOLD_A) return { status: "charging" };
  if (latest.current >= -DISCHARGE_CURRENT_THRESHOLD_A) return { status: "idle" };
  if (!Number.isFinite(latest.remainingCapacity) || latest.remainingCapacity < 0) {
    return { status: "unavailable" };
  }
  if (latest.remainingCapacity === 0) return { status: "depleted" };

  const recentDischargeSamples = collectContiguousRecentSamples(
    validSamples,
    latest.timestamp,
    (sample) => sample.current < -DISCHARGE_CURRENT_THRESHOLD_A,
  );
  const firstRecent = recentDischargeSamples[0];
  const useAverage =
    recentDischargeSamples.length > 1 &&
    recentDischargeSamples.at(-1).timestamp - firstRecent.timestamp >= MIN_AVERAGE_SPAN_MS;
  const consumptionSamples = useAverage ? recentDischargeSamples : [latest];
  const averageCurrent =
    consumptionSamples.reduce((sum, sample) => sum + Math.abs(sample.current), 0) /
    consumptionSamples.length;
  const powerSamples = consumptionSamples.filter(
    (sample) => Number.isFinite(sample.power) && sample.power < 0,
  );
  const averagePower =
    powerSamples.length > 0
      ? powerSamples.reduce((sum, sample) => sum + Math.abs(sample.power), 0) /
        powerSamples.length
      : undefined;
  const runtimeHours = latest.remainingCapacity / averageCurrent;

  if (!Number.isFinite(runtimeHours)) return { status: "unavailable" };

  return {
    status: "discharging",
    method: useAverage ? "average" : "current",
    remainingCapacity: latest.remainingCapacity,
    averageCurrent,
    averagePower,
    runtimeHours,
  };
}

export function estimateChargeRuntime(samples) {
  if (!Array.isArray(samples)) {
    throw new TypeError("Вимірювання заряджання мають бути масивом.");
  }
  if (samples.length === 0) return { status: "unavailable" };

  const validSamples = samples
    .filter(({ timestamp, current }) => Number.isFinite(timestamp) && Number.isFinite(current))
    .sort((first, second) => first.timestamp - second.timestamp);
  const latest = validSamples.at(-1);
  if (!latest) return { status: "unavailable" };
  if (latest.current < -DISCHARGE_CURRENT_THRESHOLD_A) return { status: "discharging" };
  if (latest.current <= DISCHARGE_CURRENT_THRESHOLD_A) return { status: "idle" };

  if (
    !Number.isFinite(latest.remainingCapacity) ||
    latest.remainingCapacity < 0 ||
    !Number.isFinite(latest.stateOfCharge) ||
    latest.stateOfCharge < 0 ||
    latest.stateOfCharge > 100
  ) {
    return { status: "unavailable" };
  }

  const inferredFullCapacity =
    latest.stateOfCharge > 0
      ? latest.remainingCapacity / (latest.stateOfCharge / 100)
      : undefined;
  const fullCapacity =
    Number.isFinite(latest.fullCapacity) && latest.fullCapacity > 0
      ? latest.fullCapacity
      : inferredFullCapacity;

  if (!Number.isFinite(fullCapacity) || fullCapacity <= 0) {
    return { status: "unavailable" };
  }
  if (latest.stateOfCharge >= 100 || latest.remainingCapacity >= fullCapacity) {
    return { status: "full", fullCapacity };
  }

  const recentChargeSamples = collectContiguousRecentSamples(
    validSamples,
    latest.timestamp,
    (sample) => sample.current > DISCHARGE_CURRENT_THRESHOLD_A,
  );
  const firstRecent = recentChargeSamples[0];
  const useAverage =
    recentChargeSamples.length > 1 &&
    recentChargeSamples.at(-1).timestamp - firstRecent.timestamp >= MIN_AVERAGE_SPAN_MS;
  const chargeSamples = useAverage ? recentChargeSamples : [latest];
  const averageCurrent =
    chargeSamples.reduce((sum, sample) => sum + sample.current, 0) / chargeSamples.length;
  const powerSamples = chargeSamples.filter(
    (sample) => Number.isFinite(sample.power) && sample.power > 0,
  );
  const averagePower =
    powerSamples.length > 0
      ? powerSamples.reduce((sum, sample) => sum + sample.power, 0) / powerSamples.length
      : undefined;
  const remainingCapacity = Math.max(0, fullCapacity - latest.remainingCapacity);
  const runtimeHours = remainingCapacity / averageCurrent;

  if (!Number.isFinite(runtimeHours) || runtimeHours < 0) {
    return { status: "unavailable" };
  }

  return {
    status: "charging",
    method: useAverage ? "average" : "current",
    remainingCapacity,
    fullCapacity,
    stateOfCharge: latest.stateOfCharge,
    averageCurrent,
    averagePower,
    runtimeHours,
  };
}
