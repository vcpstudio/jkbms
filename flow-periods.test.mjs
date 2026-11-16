import test from "node:test";
import assert from "node:assert/strict";
import { buildFlowPeriods, FLOW_IDLE_GAP_MS } from "./flow-periods.mjs";

const sample = (timestamp, current, extra = {}) => ({
  timestamp,
  current,
  voltage: 48,
  power: 48 * current,
  stateOfCharge: 80,
  sessionId: "session-1",
  ...extra,
});

test("combines same-direction activity across short idle gaps and calculates energy and SOC change", () => {
  const periods = buildFlowPeriods(
    [
      sample(0, 0),
      sample(1_000, -2, { stateOfCharge: 80 }),
      sample(11_000, 0, { power: 0, stateOfCharge: 79 }),
      sample(60_000, -3, { stateOfCharge: 79 }),
      sample(70_000, 0, { power: 0, stateOfCharge: 78 }),
    ],
    70_000 + FLOW_IDLE_GAP_MS + 1,
  );

  assert.equal(periods.length, 1);
  assert.equal(periods[0].direction, "discharge");
  assert.equal(periods[0].activeDurationMs, 20_000);
  assert.equal(periods[0].energyKwh, 2_400 / 3_600_000);
  assert.equal(periods[0].averageVoltage, 48);
  assert.equal(periods[0].minCurrent, 2);
  assert.equal(periods[0].maxCurrent, 3);
  assert.equal(periods[0].socChange, -2);
});

test("splits same-direction activity when the idle gap exceeds five minutes", () => {
  const periods = buildFlowPeriods(
    [
      sample(0, 0),
      sample(1_000, 5),
      sample(2_000, 0, { power: 0 }),
      sample(2_000 + FLOW_IDLE_GAP_MS + 1, 4),
    ],
    2_000 + FLOW_IDLE_GAP_MS + 2,
  );

  assert.equal(periods.length, 2);
  assert.equal(periods[0].endTimestamp, 2_000);
  assert.equal(periods[1].startTimestamp, 2_000 + FLOW_IDLE_GAP_MS + 1);
});

test("starts a new period on a direction change and keeps session boundaries separate", () => {
  const periods = buildFlowPeriods([
    sample(0, 0),
    sample(1_000, 3),
    sample(6_000, -2),
    sample(10_000, -2, { sessionId: "session-2" }),
  ]);

  assert.deepEqual(periods.map(({ direction }) => direction), ["charge", "discharge", "discharge"]);
  assert.equal(periods[0].endTimestamp, 6_000);
  assert.equal(periods[1].status, "interrupted");
  assert.equal(periods[2].status, "active");
});

test("closes the observed interval at a connection boundary", () => {
  const periods = buildFlowPeriods([
    sample(0, 0),
    sample(1_000, -2),
    sample(6_000, -2, { kind: "connection-end" }),
  ]);

  assert.equal(periods.length, 1);
  assert.equal(periods[0].endTimestamp, 6_000);
  assert.equal(periods[0].status, "connection-ended");
  assert.equal(periods[0].activeDurationMs, 5_000);
});

test("treats near-zero current as idle rather than creating a noisy direction change", () => {
  const periods = buildFlowPeriods(
    [
      sample(0, 0),
      sample(1_000, -2),
      sample(2_000, 0.04),
      sample(3_000, -1.5),
    ],
    3_000,
  );

  assert.equal(periods.length, 1);
  assert.equal(periods[0].direction, "discharge");
  assert.equal(periods[0].minCurrent, 1.5);
  assert.equal(periods[0].maxCurrent, 2);
});

test("marks a period that begins mid-flow as having an unobserved start boundary", () => {
  const [period] = buildFlowPeriods([sample(1_000, 4)]);

  assert.equal(period.startBoundaryKnown, false);
});
