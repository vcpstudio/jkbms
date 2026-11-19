import test from "node:test";
import assert from "node:assert/strict";
import {
  FRAME_HEADER,
  FRAME_LENGTH,
  FrameAssembler,
  checksum,
  createCommand,
  decodeLiveData,
  decodeSettings,
  detectProtocolVersion,
} from "./protocol.mjs";

function makeFrame(type) {
  const frame = new Uint8Array(FRAME_LENGTH);
  frame.set(FRAME_HEADER);
  frame[4] = type;
  frame[FRAME_LENGTH - 1] = checksum(frame);
  return frame;
}

test("creates a 20-byte JK command with checksum and counter", () => {
  const frame = createCommand(0x96, 7);
  assert.equal(frame.length, 20);
  assert.deepEqual([...frame.slice(0, 5)], [0xaa, 0x55, 0x90, 0xeb, 0x96]);
  assert.equal(frame[16], 7);
  assert.equal(frame[19], checksum(frame, 19));
});


test("assembles a fragmented notification and rejects a bad checksum", () => {
  const frame = makeFrame(0x01);
  const assembler = new FrameAssembler();
  assert.equal(assembler.push(frame.slice(0, 91)).length, 0);
  const result = assembler.push(frame.slice(91));
  assert.equal(result.length, 1);
  assert.deepEqual([...result[0]], [...frame]);

  const invalid = frame.slice();
  invalid[18] = 1;
  const secondAssembler = new FrameAssembler();
  assert.equal(secondAssembler.push(invalid).length, 0);
});

test("reads JK settings and decodes 24-cell telemetry", () => {
  const settingsFrame = makeFrame(0x01);
  settingsFrame[114] = 24;
  settingsFrame[118] = 1;
  settingsFrame[122] = 1;
  settingsFrame[126] = 1;
  settingsFrame[299] = checksum(settingsFrame);
  assert.deepEqual(decodeSettings(settingsFrame), {
    cellCount: 24,
    chargingEnabled: true,
    dischargingEnabled: true,
    balancingEnabled: true,
  });

  const liveFrame = makeFrame(0x02);
  const view = new DataView(liveFrame.buffer);
  for (let index = 0; index < 24; index += 1) {
    view.setUint16(6 + index * 2, 3300 + index, true);
  }
  view.setUint16(64, 18, true);
  view.setUint16(64 + 23 * 2, 27, true);
  view.setUint32(118, 79200, true);
  view.setInt32(126, -12500, true);
  view.setUint8(141, 80);
  view.setUint32(142, 12000, true);
  view.setUint32(146, 150000, true);
  view.setUint32(150, 50, true);
  liveFrame[299] = checksum(liveFrame);

  const result = decodeLiveData(liveFrame, 24);
  assert.equal(result.cellVoltages.length, 24);
  assert.equal(result.cellResistances.length, 24);
  assert.equal(result.cellResistances[0], 0.018);
  assert.equal(result.cellResistances[23], 0.027);
  assert.equal(result.voltage, 79.2);
  assert.equal(result.current, -12.5);
  assert.equal(result.power, -990);
  assert.equal(result.stateOfCharge, 80);
  assert.equal(result.nominalCapacity, 150);
  assert.equal(result.cycleCount, 50);
});

test("reads 8-cell telemetry from the JK02_32S field layout", () => {
  const liveFrame = makeFrame(0x02);
  const view = new DataView(liveFrame.buffer);
  for (let index = 0; index < 8; index += 1) {
    view.setUint16(6 + index * 2, 3200 + index, true);
  }
  view.setUint16(80, 14, true);
  view.setUint16(80 + 7 * 2, 21, true);
  view.setUint32(150, 102400, true);
  view.setInt32(158, 2500, true);
  view.setUint8(173, 65);
  view.setUint32(174, 182000, true);
  view.setUint32(178, 280000, true);
  liveFrame[299] = checksum(liveFrame);

  const result = decodeLiveData(liveFrame, 8, "JK02_32S");
  assert.equal(result.cellVoltages.length, 8);
  assert.equal(result.cellResistances.length, 8);
  assert.equal(result.cellResistances[0], 0.014);
  assert.equal(result.cellResistances[7], 0.021);
  assert.equal(result.voltage, 102.4);
  assert.equal(result.current, 2.5);
  assert.equal(result.power, 256);
  assert.equal(result.stateOfCharge, 65);
  assert.equal(result.remainingCapacity, 182);
  assert.equal(result.nominalCapacity, 280);
});

test("ignores zero-voltage cells in averageCellVoltage and cellVoltageDelta", () => {
  const liveFrame = makeFrame(0x02);
  const view = new DataView(liveFrame.buffer);
  view.setUint16(6, 3300, true);
  view.setUint16(8, 3320, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 3310, true);
  liveFrame[299] = checksum(liveFrame);

  const result = decodeLiveData(liveFrame, 4, "JK02_32S");
  assert.equal(result.averageCellVoltage, 3.31);
  assert.ok(Math.abs(result.cellVoltageDelta - 0.02) < 1e-9);
});

test("decodes 24S protection alarms and leaves unused bits visible", () => {
  const liveFrame = makeFrame(0x02);
  const view = new DataView(liveFrame.buffer);
  view.setUint16(136, (1 << 5) | (1 << 3), true);
  liveFrame[299] = checksum(liveFrame);

  const result = decodeLiveData(liveFrame, 8, "JK02_24S");

  assert.deepEqual(result.protectionAlerts.map(({ bit }) => bit), [5]);
  assert.equal(result.unknownProtectionMask, 1 << 3);
});

test("decodes 32S protection alarms and reports unknown flags", () => {
  const liveFrame = makeFrame(0x02);
  const view = new DataView(liveFrame.buffer);
  view.setUint32(166, (1 << 11) | (1 << 31), true);
  liveFrame[299] = checksum(liveFrame);

  const result = decodeLiveData(liveFrame, 8, "JK02_32S");

  assert.deepEqual(result.protectionAlerts.map(({ bit }) => bit), [11]);
  assert.equal(result.unknownProtectionMask, 0x80000000);
});

test("selects JK02_32S for JK_B1A8S20P independently of its 8-cell count", () => {
  assert.equal(
    detectProtocolVersion({
      model: "JK_B1A8S20P",
      hardwareVersion: "19.h",
      firmwareVersion: "11.54",
    }),
    "JK02_32S",
  );
  assert.equal(
    detectProtocolVersion({
      model: "JK-B2A20S15P",
      hardwareVersion: "8.x",
      firmwareVersion: "8.20",
    }),
    "JK02_24S",
  );
});
