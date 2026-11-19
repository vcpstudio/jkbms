import test from "node:test";
import assert from "node:assert/strict";
import {
  formatCsvCell,
  minMaxValues,
  parseFlowChunkEntries,
  resolveRecentDevices,
  selectChunksToEvict,
  shouldRecordFlowSample,
} from "./app-utils.mjs";

test("formatCsvCell preserves numeric values including negative numbers while escaping formulas", () => {
  assert.equal(formatCsvCell(-12.5), '"-12.5"');
  assert.equal(formatCsvCell(-650), '"-650"');
  assert.equal(formatCsvCell(0), '"0"');
  assert.equal(formatCsvCell(53.2), '"53.2"');
  assert.equal(formatCsvCell("=SUM(A1:A2)"), `"'=SUM(A1:A2)"`);
  assert.equal(formatCsvCell("-cmd"), `"-cmd"`.replace('"', `"'`));
  assert.equal(formatCsvCell("+1+2"), `"'+1+2"`);
  assert.equal(formatCsvCell("@alert"), `"'@alert"`);
  assert.equal(formatCsvCell('JK "BMS"'), '"JK ""BMS"""');
});

test("minMaxValues handles large arrays without stack overflow and ignores non-finite values", () => {
  const values = Array.from({ length: 120_000 }, (_, index) => 3.2 + (index % 100) * 0.001);
  values.push(NaN, Infinity, -Infinity);

  const result = minMaxValues(values);
  assert.ok(result);
  assert.ok(Math.abs(result.min - 3.2) < 1e-9);
  assert.ok(Math.abs(result.max - 3.299) < 1e-9);
  assert.equal(minMaxValues([]), undefined);
  assert.equal(minMaxValues([NaN, Infinity]), undefined);
});

test("shouldRecordFlowSample suppresses mA noise but records regime changes, large jumps, and intervals", () => {
  assert.equal(
    shouldRecordFlowSample({
      current: -12.345,
      previousCurrent: undefined,
      timestamp: 1000,
      lastSampleAt: undefined,
      sampleIntervalMs: 5000,
    }),
    true,
  );

  // Small 4 mA fluctuation within 5s should NOT be recorded
  assert.equal(
    shouldRecordFlowSample({
      current: -12.349,
      previousCurrent: -12.345,
      timestamp: 2000,
      lastSampleAt: 1000,
      sampleIntervalMs: 5000,
    }),
    false,
  );

  // Significant >= 0.5 A change IS recorded immediately
  assert.equal(
    shouldRecordFlowSample({
      current: -13.0,
      previousCurrent: -12.345,
      timestamp: 2000,
      lastSampleAt: 1000,
      sampleIntervalMs: 5000,
    }),
    true,
  );

  // Direction change (discharge -> idle) IS recorded immediately
  assert.equal(
    shouldRecordFlowSample({
      current: 0.02,
      previousCurrent: -0.3,
      timestamp: 2000,
      lastSampleAt: 1000,
      sampleIntervalMs: 5000,
    }),
    true,
  );

  // Steady active current recorded after sampleIntervalMs
  assert.equal(
    shouldRecordFlowSample({
      current: -12.345,
      previousCurrent: -12.345,
      timestamp: 6000,
      lastSampleAt: 1000,
      sampleIntervalMs: 5000,
    }),
    true,
  );

  // Steady idle current is throttled to idleIntervalMs (60s)
  assert.equal(
    shouldRecordFlowSample({
      current: 0.01,
      previousCurrent: 0.02,
      timestamp: 10_000,
      lastSampleAt: 1000,
      sampleIntervalMs: 5000,
    }),
    false,
  );
  assert.equal(
    shouldRecordFlowSample({
      current: 0.01,
      previousCurrent: 0.02,
      timestamp: 61_000,
      lastSampleAt: 1000,
      sampleIntervalMs: 5000,
    }),
    true,
  );
});

test("parseFlowChunkEntries recovers valid chunks when another chunk is corrupted", () => {
  const prefix = "jk-bms-monitor.flow-events.v1.dev1.";
  const result = parseFlowChunkEntries(
    [
      {
        key: `${prefix}session-1.0`,
        raw: JSON.stringify([
          [1000, -5, 52.1, -260.5, 80],
          [6000, -5, 52.0, -260.0, 80, "connection-end"],
        ]),
      },
      {
        key: `${prefix}session-bad.0`,
        raw: "{not valid json",
      },
      {
        key: `${prefix}session-2.0`,
        raw: JSON.stringify([[2000, 10, 53.0, 530, 81]]),
      },
    ],
    prefix,
  );

  assert.equal(result.errors.length, 1);
  assert.equal(result.samples.length, 3);
  assert.deepEqual(
    result.samples.map((s) => s.timestamp),
    [1000, 2000, 6000],
  );
});

test("selectChunksToEvict removes oldest chunks while preserving the protected active chunk", () => {
  const toEvict = selectChunksToEvict(
    [
      { key: "c3", oldestTimestamp: 3000 },
      { key: "c1", oldestTimestamp: 1000 },
      { key: "c2", oldestTimestamp: 2000 },
      { key: "active", oldestTimestamp: 500 },
    ],
    2,
    "active",
  );

  assert.deepEqual(toEvict, ["c1", "c2"]);
});

test("resolveRecentDevices matches by deviceId and falls back to unique device name", () => {
  const scanned = [
    { deviceId: "AA:BB:CC:01", deviceName: "JK_B1A8S20P" },
    { deviceId: "AA:BB:CC:02", deviceName: "JK_DUPLICATE" },
    { deviceId: "AA:BB:CC:03", deviceName: "JK_DUPLICATE" },
    { deviceId: "AA:BB:CC:04", deviceName: "JK_UNIQUE" },
  ];

  const matched = resolveRecentDevices(
    [
      { id: "AA:BB:CC:01", name: "JK_B1A8S20P" },
      { id: "legacy-web-bt-base64-id==", name: "JK_UNIQUE" },
      { id: "legacy-ambiguous-id==", name: "JK_DUPLICATE" },
      { id: "duplicate-entry", name: "JK_B1A8S20P" },
    ],
    scanned,
  );

  assert.deepEqual(
    matched.map((d) => d.deviceId),
    ["AA:BB:CC:01", "AA:BB:CC:04"],
  );
});
