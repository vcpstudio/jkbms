export const DISCHARGE_CURRENT_THRESHOLD_A = 0.1;
export const DISCHARGE_FORECAST_WINDOW_MS = 5 * 60 * 1000;
const MIN_AVERAGE_SPAN_MS = 30 * 1000;

export function estimateDischargeRuntime(samples) {
  if (!Array.isArray(samples)) {
    throw new TypeError("Вимірювання споживання мають бути масивом.");
  }
  if (samples.length === 0) return { status: "unavailable" };

  const validSamples = samples.filter(
    ({ timestamp, current }) => Number.isFinite(timestamp) && Number.isFinite(current),
  );
  const latest = validSamples.at(-1);
  if (!latest) return { status: "unavailable" };
  if (latest.current > DISCHARGE_CURRENT_THRESHOLD_A) return { status: "charging" };
  if (latest.current >= -DISCHARGE_CURRENT_THRESHOLD_A) return { status: "idle" };
  if (!Number.isFinite(latest.remainingCapacity) || latest.remainingCapacity < 0) {
    return { status: "unavailable" };
  }
  if (latest.remainingCapacity === 0) return { status: "depleted" };

  const recentDischargeSamples = validSamples.filter(
    (sample) =>
      sample.timestamp >= latest.timestamp - DISCHARGE_FORECAST_WINDOW_MS &&
      sample.current < -DISCHARGE_CURRENT_THRESHOLD_A,
  );
  const firstRecent = recentDischargeSamples[0];
  const useAverage =
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
