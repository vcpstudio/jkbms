import test from "node:test";
import assert from "node:assert/strict";
import { estimateDischargeRuntime } from "./discharge-forecast.mjs";

test("estimates remaining time from average discharge current over the recent window", () => {
  const estimate = estimateDischargeRuntime([
    { timestamp: 0, current: -30, power: -3000, remainingCapacity: 125 },
    { timestamp: 60000, current: -40, power: -4000, remainingCapacity: 120 },
  ]);

  assert.equal(estimate.status, "discharging");
  assert.equal(estimate.method, "average");
  assert.equal(estimate.averageCurrent, 35);
  assert.equal(estimate.averagePower, 3500);
  assert.equal(estimate.runtimeHours, 120 / 35);
});

test("uses the current discharge rate until enough history is available", () => {
  const estimate = estimateDischargeRuntime([
    { timestamp: 0, current: -30, power: -3000, remainingCapacity: 90 },
  ]);

  assert.equal(estimate.method, "current");
  assert.equal(estimate.averageCurrent, 30);
  assert.equal(estimate.runtimeHours, 3);
});

test("does not predict runtime while charging, idle, or without valid telemetry", () => {
  assert.deepEqual(estimateDischargeRuntime([]), { status: "unavailable" });
  assert.equal(
    estimateDischargeRuntime([{ timestamp: 0, current: 4, remainingCapacity: 90 }]).status,
    "charging",
  );
  assert.equal(
    estimateDischargeRuntime([{ timestamp: 0, current: -0.05, remainingCapacity: 90 }]).status,
    "idle",
  );
  assert.equal(
    estimateDischargeRuntime([{ timestamp: 0, current: -10, remainingCapacity: 0 }]).status,
    "depleted",
  );
});
