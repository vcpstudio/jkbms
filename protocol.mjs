export const SERVICE_UUID = 0xffe0;
export const CHARACTERISTIC_UUID = 0xffe1;
export const FRAME_HEADER = new Uint8Array([0x55, 0xaa, 0xeb, 0x90]);
export const FRAME_LENGTH = 300;

const COMMAND_HEADER = new Uint8Array([0xaa, 0x55, 0x90, 0xeb]);

const PROTECTION_FLAGS = [
  { bit: 0, label: "Попередження про опір з'єднання комірки", severity: "warning" },
  { bit: 1, label: "Перегрів силових MOSFET", severity: "critical" },
  { bit: 2, label: "Кількість комірок не збігається з налаштуванням", severity: "warning" },
  { bit: 4, label: "Акумулятор повністю заряджений", severity: "info" },
  { bit: 5, label: "Перенапруга батарейного блока", severity: "critical" },
  { bit: 6, label: "Надструм заряджання", severity: "critical" },
  { bit: 7, label: "Коротке замикання під час заряджання", severity: "critical" },
  { bit: 8, label: "Перегрів під час заряджання", severity: "critical" },
  { bit: 9, label: "Переохолодження під час заряджання", severity: "critical" },
  { bit: 10, label: "Помилка зв'язку з контролером", severity: "critical" },
  { bit: 11, label: "Занижена напруга комірки", severity: "critical" },
  { bit: 12, label: "Занижена напруга батарейного блока", severity: "critical" },
  { bit: 13, label: "Надструм розряджання", severity: "critical" },
  { bit: 14, label: "Коротке замикання під час розряджання", severity: "critical" },
  { bit: 15, label: "Перегрів під час розряджання", severity: "critical" },
  { bit: 16, label: "Несправність MOSFET заряджання", severity: "critical" },
  { bit: 17, label: "Несправність MOSFET розряджання", severity: "critical" },
  { bit: 18, label: "GPS від'єднано", severity: "info" },
  { bit: 19, label: "Нагадування про зміну пароля BMS", severity: "info" },
  { bit: 20, label: "Помилка розряджання", severity: "critical" },
  { bit: 21, label: "Перегрів батареї", severity: "critical" },
  { bit: 22, label: "Аномалія датчика температури", severity: "critical" },
  { bit: 23, label: "Помилка PL-модуля", severity: "warning" },
  { bit: 24, label: "Захист від короткого замикання не скинувся", severity: "critical" },
  { bit: 25, label: "Друге спрацювання захисту від надструму розряджання", severity: "critical" },
  { bit: 26, label: "Третє спрацювання захисту від надструму розряджання", severity: "critical" },
  { bit: 27, label: "Переохолодження під час розряджання", severity: "critical" },
  { bit: 28, label: "Віддалене блокування GPS", severity: "warning" },
];

export function checksum(bytes, length = bytes.length - 1) {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum = (sum + bytes[index]) & 0xff;
  }
  return sum;
}

export function createCommand(command, counter = 0) {
  if (!Number.isInteger(command) || command < 0 || command > 0xff) {
    throw new RangeError("Команда має бути байтом.");
  }

  const frame = new Uint8Array(20);
  frame.set(COMMAND_HEADER);
  frame[4] = command;
  frame[16] = counter & 0xff;
  frame[19] = checksum(frame, 19);
  return frame;
}

export class FrameAssembler {
  #buffer = new Uint8Array();

  push(chunk) {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    const joined = new Uint8Array(this.#buffer.length + incoming.length);
    joined.set(this.#buffer);
    joined.set(incoming, this.#buffer.length);
    this.#buffer = joined;

    const frames = [];
    while (this.#buffer.length >= FRAME_HEADER.length) {
      const start = this.#findHeader();
      if (start < 0) {
        this.#buffer = this.#buffer.slice(-3);
        break;
      }
      if (start > 0) this.#buffer = this.#buffer.slice(start);
      if (this.#buffer.length < FRAME_LENGTH) break;

      const candidate = this.#buffer.slice(0, FRAME_LENGTH);
      if (candidate[FRAME_LENGTH - 1] === checksum(candidate)) {
        frames.push(candidate);
        this.#buffer = this.#buffer.slice(FRAME_LENGTH);
      } else {
        this.#buffer = this.#buffer.slice(1);
      }
    }

    return frames;
  }

  #findHeader() {
    for (let start = 0; start <= this.#buffer.length - FRAME_HEADER.length; start += 1) {
      if (FRAME_HEADER.every((byte, index) => this.#buffer[start + index] === byte)) {
        return start;
      }
    }
    return -1;
  }
}

export function decodeSettings(frame) {
  assertFrame(frame, 0x01);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const cellCount = view.getUint8(114);
  if (cellCount < 1 || cellCount > 32) {
    throw new Error(`Непідтримувана кількість комірок у відповіді BMS: ${cellCount}.`);
  }

  return {
    cellCount,
    chargingEnabled: view.getUint8(118) !== 0,
    dischargingEnabled: view.getUint8(122) !== 0,
    balancingEnabled: view.getUint8(126) !== 0,
  };
}

export function decodeDeviceInfo(frame) {
  assertFrame(frame, 0x03);
  return {
    model: readText(frame.subarray(6, 22)),
    hardwareVersion: readText(frame.subarray(22, 30)),
    firmwareVersion: readText(frame.subarray(30, 38)),
  };
}

export function detectProtocolVersion(deviceInfo, advertisedName = "") {
  const model = deviceInfo.model.toUpperCase();
  const identifiers = `${model} ${advertisedName}`.toUpperCase();
  if (
    model.startsWith("JK_") ||
    identifiers.includes("B1A8S20P") ||
    identifiers.includes("B1A8S10P") ||
    identifiers.includes("BXAXS-XP")
  ) {
    return "JK02_32S";
  }

  const hardwareMajor = Number.parseInt(deviceInfo.hardwareVersion.match(/\d+/)?.[0] ?? "", 10);
  if (Number.isFinite(hardwareMajor) && hardwareMajor >= 11) return "JK02_32S";
  if (Number.isFinite(hardwareMajor) && hardwareMajor >= 6) return "JK02_24S";
  if (Number.isFinite(hardwareMajor) && hardwareMajor <= 3) {
    throw new Error("Старий протокол JK04 поки не підтримується.");
  }

  throw new Error("Не вдалося визначити протокол BMS за її моделлю та апаратною версією.");
}

export function decodeLiveData(frame, cellCount, protocolVersion = "JK02_24S") {
  assertFrame(frame, 0x02);
  if (!Number.isInteger(cellCount) || cellCount < 1 || cellCount > 32) {
    throw new Error("Спочатку зчитай налаштування, щоб визначити кількість комірок.");
  }
  if (protocolVersion !== "JK02_24S" && protocolVersion !== "JK02_32S") {
    throw new Error(`Непідтримуваний протокол BMS: ${protocolVersion}.`);
  }
  if (protocolVersion === "JK02_24S" && cellCount > 24) {
    throw new Error("Профіль JK02_24S не підтримує понад 24 комірки.");
  }

  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const is32CellLayout = protocolVersion === "JK02_32S";
  const cellOffset = 6;
  const cellResistanceOffset = is32CellLayout ? 80 : 64;
  const packVoltageOffset = is32CellLayout ? 150 : 118;
  const currentOffset = is32CellLayout ? 158 : 126;
  const temperature1Offset = is32CellLayout ? 162 : 130;
  const temperature2Offset = is32CellLayout ? 164 : 132;
  const mosTemperatureOffset = is32CellLayout ? 144 : 134;
  const balanceCurrentOffset = is32CellLayout ? 170 : 62;
  const socOffset = is32CellLayout ? 173 : 141;
  const remainingCapacityOffset = is32CellLayout ? 174 : 142;
  const cycleCountOffset = is32CellLayout ? 182 : 150;
  const protectionOffset = is32CellLayout ? 166 : 136;
  const cellVoltages = [];
  const cellResistances = [];

  for (let index = 0; index < cellCount; index += 1) {
    cellVoltages.push(view.getUint16(cellOffset + index * 2, true) / 1000);
    cellResistances.push(view.getUint16(cellResistanceOffset + index * 2, true) / 1000);
  }

  const sumVoltage = cellVoltages.reduce((sum, value) => sum + value, 0);
  const voltage = view.getUint32(packVoltageOffset, true) / 1000;
  const current = view.getInt32(currentOffset, true) / 1000;
  const protectionMask = is32CellLayout
    ? view.getUint32(protectionOffset, true)
    : view.getUint16(protectionOffset, true);
  const knownProtectionMask = PROTECTION_FLAGS.reduce(
    (mask, { bit }) => (bit < (is32CellLayout ? 32 : 16) ? mask | (1 << bit) : mask),
    0,
  );

  return {
    timestamp: new Date().toISOString(),
    cellVoltages,
    cellResistances,
    voltage,
    current,
    power: voltage * current,
    stateOfCharge: view.getUint8(socOffset),
    remainingCapacity: view.getUint32(remainingCapacityOffset, true) / 1000,
    cycleCount: view.getUint32(cycleCountOffset, true),
    averageCellVoltage: sumVoltage / cellVoltages.length,
    cellVoltageDelta: Math.max(...cellVoltages) - Math.min(...cellVoltages),
    balanceCurrent: view.getInt16(balanceCurrentOffset, true) / 1000,
    temperature1: view.getInt16(temperature1Offset, true) / 10,
    temperature2: view.getInt16(temperature2Offset, true) / 10,
    mosTemperature: view.getInt16(mosTemperatureOffset, true) / 10,
    protectionAlerts: PROTECTION_FLAGS.filter(({ bit }) => (protectionMask & (1 << bit)) !== 0),
    unknownProtectionMask: (protectionMask & ~knownProtectionMask) >>> 0,
  };
}

function assertFrame(frame, type) {
  if (
    !(frame instanceof Uint8Array) ||
    frame.length !== FRAME_LENGTH ||
    !FRAME_HEADER.every((byte, index) => frame[index] === byte) ||
    frame[4] !== type ||
    frame[FRAME_LENGTH - 1] !== checksum(frame)
  ) {
    throw new Error("Отримано некоректний або непідтримуваний кадр JK BMS.");
  }
}

function readText(bytes) {
  return new TextDecoder().decode(bytes).replace(/\0.*$/s, "").trim();
}
