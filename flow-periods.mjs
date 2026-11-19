export const FLOW_IDLE_GAP_MS = 5 * 60 * 1000;
export const FLOW_CURRENT_DEADBAND_A = 0.1;

export function buildFlowPeriods(
  samples,
  now = Date.now(),
  idleGapMs = FLOW_IDLE_GAP_MS,
  options = {},
) {
  const { activeSessionId } = options;
  const groupedSamples = new Map();
  for (const sample of samples) {
    if (!Number.isFinite(sample.timestamp) || !Number.isFinite(sample.current)) continue;
    const sessionId = sample.sessionId ?? "legacy";
    if (!groupedSamples.has(sessionId)) groupedSamples.set(sessionId, []);
    groupedSamples.get(sessionId).push(sample);
  }

  const sessions = [...groupedSamples.values()]
    .map((sessionSamples) => sessionSamples.sort((first, second) => first.timestamp - second.timestamp))
    .sort((first, second) => first[0].timestamp - second[0].timestamp);
  const periods = [];

  sessions.forEach((sessionSamples, sessionIndex) => {
    const sessionId = sessionSamples[0].sessionId ?? "legacy";
    const isActiveSession =
      activeSessionId !== undefined
        ? sessionId === activeSessionId
        : sessionIndex === sessions.length - 1;
    let period;
    let previousSample;
    let idleSince;

    const directionOf = (current) =>
      current > FLOW_CURRENT_DEADBAND_A
        ? "charge"
        : current < -FLOW_CURRENT_DEADBAND_A
          ? "discharge"
          : null;
    const addSample = (sample) => {
      period.endTimestamp = sample.timestamp;
      if (Number.isFinite(sample.stateOfCharge)) period.endSoc = sample.stateOfCharge;
      if (Number.isFinite(sample.voltage)) {
        period.voltageSampleTotal += sample.voltage;
        period.voltageSampleCount += 1;
      }
      if (directionOf(sample.current) === period.direction) {
        const magnitude = Math.abs(sample.current);
        period.minCurrent = Math.min(period.minCurrent, magnitude);
        period.maxCurrent = Math.max(period.maxCurrent, magnitude);
      }
    };
    const integrateInterval = (from, to) => {
      if (!from || directionOf(from.current) !== period.direction) return;
      const duration = Math.max(0, to.timestamp - from.timestamp);
      if (duration === 0) return;

      period.activeDurationMs += duration;
      if (Number.isFinite(from.voltage)) {
        period.voltageIntegral += from.voltage * duration;
        period.voltageDurationMs += duration;
      }
      const power = Number.isFinite(from.power)
        ? Math.abs(from.power)
        : Number.isFinite(from.voltage)
          ? Math.abs(from.voltage * from.current)
          : undefined;
      if (power !== undefined) {
        period.energyWattMilliseconds += power * duration;
      }
    };
    const begin = (sample, direction, startBoundaryKnown) => {
      period = {
        sessionId: sample.sessionId ?? "legacy",
        direction,
        startTimestamp: sample.timestamp,
        endTimestamp: sample.timestamp,
        startSoc: Number.isFinite(sample.stateOfCharge) ? sample.stateOfCharge : undefined,
        endSoc: Number.isFinite(sample.stateOfCharge) ? sample.stateOfCharge : undefined,
        minCurrent: Math.abs(sample.current),
        maxCurrent: Math.abs(sample.current),
        activeDurationMs: 0,
        voltageIntegral: 0,
        voltageDurationMs: 0,
        voltageSampleTotal: Number.isFinite(sample.voltage) ? sample.voltage : 0,
        voltageSampleCount: Number.isFinite(sample.voltage) ? 1 : 0,
        energyWattMilliseconds: 0,
        startBoundaryKnown,
      };
    };
    const finish = (timestamp, status, endBoundaryKnown) => {
      if (!period) return;
      period.endTimestamp = timestamp;
      period.status = status;
      period.endBoundaryKnown = endBoundaryKnown;
      period.socChange = Number.isFinite(period.startSoc) && Number.isFinite(period.endSoc)
        ? period.endSoc - period.startSoc
        : undefined;
      period.averageVoltage = period.voltageDurationMs > 0
        ? period.voltageIntegral / period.voltageDurationMs
        : period.voltageSampleCount > 0
          ? period.voltageSampleTotal / period.voltageSampleCount
          : undefined;
      period.energyKwh = period.energyWattMilliseconds > 0
        ? period.energyWattMilliseconds / 3_600_000_000
        : undefined;
      delete period.voltageIntegral;
      delete period.voltageDurationMs;
      delete period.voltageSampleTotal;
      delete period.voltageSampleCount;
      delete period.energyWattMilliseconds;
      periods.push(period);
      period = undefined;
    };

    for (const sample of sessionSamples) {
      if (sample.kind === "connection-end") {
        if (period) {
          if (idleSince === undefined) {
            integrateInterval(previousSample, sample);
            addSample(sample);
            finish(sample.timestamp, "connection-ended", false);
          } else {
            finish(idleSince, "complete", true);
          }
        }
        previousSample = sample;
        idleSince = undefined;
        continue;
      }

      const direction = directionOf(sample.current);
      if (!period) {
        if (direction) {
          begin(
            sample,
            direction,
            Boolean(
              previousSample &&
                previousSample.kind !== "connection-end" &&
                directionOf(previousSample.current) === null,
            ),
          );
        }
        previousSample = sample;
        continue;
      }

      if (direction === null) {
        if (idleSince === undefined) {
          integrateInterval(previousSample, sample);
          addSample(sample);
          idleSince = sample.timestamp;
        }
        previousSample = sample;
        continue;
      }

      if (direction !== period.direction) {
        if (idleSince === undefined) {
          integrateInterval(previousSample, sample);
          addSample(sample);
        }
        finish(idleSince ?? sample.timestamp, "complete", true);
        begin(sample, direction, true);
        idleSince = undefined;
        previousSample = sample;
        continue;
      }

      if (idleSince !== undefined && sample.timestamp - idleSince > idleGapMs) {
        finish(idleSince, "complete", true);
        begin(sample, direction, true);
        idleSince = undefined;
        previousSample = sample;
        continue;
      }

      integrateInterval(previousSample, sample);
      idleSince = undefined;
      addSample(sample);
      previousSample = sample;
    }

    if (period) {
      if (idleSince !== undefined) {
        if (!isActiveSession || now - idleSince > idleGapMs) {
          finish(idleSince, "complete", true);
        } else {
          finish(idleSince, "paused", false);
        }
      } else if (isActiveSession) {
        finish(previousSample.timestamp, "active", false);
      } else {
        finish(previousSample.timestamp, "interrupted", false);
      }
    }
  });

  return periods;
}
