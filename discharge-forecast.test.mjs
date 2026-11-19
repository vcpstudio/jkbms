import test from "node:test";
import assert from "node:assert/strict";
import { estimateChargeRuntime, estimateDischargeRuntime } from "./discharge-forecast.mjs";

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

test("estimates remaining charge time from average charging current", () => {
  const estimate = estimateChargeRuntime([
    {
      timestamp: 0,
      current: 20,
      power: 2000,
      remainingCapacity: 60,
      stateOfCharge: 50,
    },
    {
      timestamp: 60000,
      current: 30,
      power: 3000,
      remainingCapacity: 60.5,
      stateOfCharge: 50,
    },
  ]);

  assert.equal(estimate.status, "charging");
  assert.equal(estimate.method, "average");
  assert.equal(estimate.averageCurrent, 25);
  assert.equal(estimate.fullCapacity, 121);
  assert.equal(estimate.remainingCapacity, 60.5);
  assert.equal(estimate.runtimeHours, 60.5 / 25);
});

test("uses current charging rate until enough history is available", () => {
  const estimate = estimateChargeRuntime([
    {
      timestamp: 0,
      current: 20,
      power: 2200,
      remainingCapacity: 60,
      stateOfCharge: 50,
    },
  ]);

  assert.equal(estimate.status, "charging");
  assert.equal(estimate.method, "current");
  assert.equal(estimate.averageCurrent, 20);
  assert.equal(estimate.runtimeHours, 3);
});

test("reports full, idle, discharging, and unavailable charge states", () => {
  assert.equal(
    estimateChargeRuntime([
      { timestamp: 0, current: 20, remainingCapacity: 120, stateOfCharge: 100 },
    ]).status,
    "full",
  );
  assert.equal(
    estimateChargeRuntime([{ timestamp: 0, current: 0.05, stateOfCharge: 50 }]).status,
    "idle",
  );
  assert.equal(
    estimateChargeRuntime([{ timestamp: 0, current: -20, stateOfCharge: 50 }]).status,
    "discharging",
  );
  assert.deepEqual(estimateChargeRuntime([]), { status: "unavailable" });
});

test("ignores earlier discharge samples separated by charging or idle intervals", () => {
  const estimate = estimateDischargeRuntime([
    { timestamp: 0, current: -50, power: -2500, remainingCapacity: 100 },
    { timestamp: 60_000, current: 20, power: 1000, remainingCapacity: 101 },
    { timestamp: 180_000, current: 0, power: 0, remainingCapacity: 101 },
    { timestamp: 200_000, current: -2, power: -100, remainingCapacity: 100 },
    { timestamp: 210_000, current: -2, power: -100, remainingCapacity: 100 },
  ]);

  assert.equal(estimate.status, "discharging");
  assert.equal(estimate.method, "current");
  assert.equal(estimate.averageCurrent, 2);
  assert.equal(estimate.runtimeHours, 50);
});

test("ignores earlier charge samples separated by discharge or idle intervals", () => {
  const estimate = estimateChargeRuntime([
    { timestamp: 0, current: 40, power: 2000, remainingCapacity: 50, stateOfCharge: 50, fullCapacity: 100 },
    { timestamp: 60_000, current: -10, power: -500, remainingCapacity: 49, stateOfCharge: 49, fullCapacity: 100 },
    { timestamp: 180_000, current: 5, power: 250, remainingCapacity: 50, stateOfCharge: 50, fullCapacity: 100 },
    { timestamp: 190_000, current: 5, power: 250, remainingCapacity: 50, stateOfCharge: 50, fullCapacity: 100 },
  ]);

  assert.equal(estimate.status, "charging");
  assert.equal(estimate.method, "current");
  assert.equal(estimate.averageCurrent, 5);
  assert.equal(estimate.runtimeHours, 10);
});

test("estimates charge runtime at 0% SOC when nominal fullCapacity is known", () => {
  const estimate = estimateChargeRuntime([
    {
      timestamp: 0,
      current: 20,
      power: 1000,
      remainingCapacity: 0,
      stateOfCharge: 0,
      fullCapacity: 280,
    },
  ]);

  assert.equal(estimate.status, "charging");
  assert.equal(estimate.fullCapacity, 280);
  assert.equal(estimate.remainingCapacity, 280);
  assert.equal(estimate.runtimeHours, 14);
});
