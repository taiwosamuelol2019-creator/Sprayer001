require("dotenv").config();

const express = require("express");
const http = require("http");
const mqtt = require("mqtt");
const cors = require("cors");
const { Server } = require("socket.io");
const { randomUUID } = require("crypto");

const app = express();
const server = http.createServer(app);

const HMI_ORIGIN = process.env.HMI_ORIGIN || "http://localhost:3000";
const PORT = Number(process.env.PORT) || 4000;
const TELEMETRY_STALE_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.TELEMETRY_STALE_TIMEOUT_MS) || 45000
);
const CONDITION_HISTORY_LIMIT = 500;

// Keep these topic names aligned with the ESP32 firmware.
const DEVICE_ID = process.env.MQTT_DEVICE_ID || "myplant-7f3k9q";

const TOPICS = {
  telemetry: `${DEVICE_ID}/telemetry`,
  status: `${DEVICE_ID}/status`,
  alarms: `${DEVICE_ID}/alarms`,
  commandAck: `${DEVICE_ID}/command_ack`,
  setpoint: `${DEVICE_ID}/cmd/setpoint`,
  standby: `${DEVICE_ID}/cmd/standby`,
  circulate: `${DEVICE_ID}/cmd/circulate`,
  fill: `${DEVICE_ID}/cmd/fill`,
  reset: `${DEVICE_ID}/cmd/reset`
};

const MQTT_URL =
  process.env.MQTT_URL ||
  `mqtts://${process.env.MQTT_HOST}:${process.env.MQTT_PORT}`;

if (
  !process.env.MQTT_URL &&
  (!process.env.MQTT_HOST || !process.env.MQTT_PORT)
) {
  throw new Error(
    "Set MQTT_URL or both MQTT_HOST and MQTT_PORT in backend/.env"
  );
}

if (!process.env.MQTT_USERNAME || !process.env.MQTT_PASSWORD) {
  throw new Error(
    "MQTT_USERNAME and MQTT_PASSWORD must be set in backend/.env"
  );
}

app.use(cors({ origin: HMI_ORIGIN }));
app.use(express.json({ limit: "100kb" }));

const io = new Server(server, {
  cors: {
    origin: HMI_ORIGIN,
    methods: ["GET", "POST"]
  }
});

const mqttClient = mqtt.connect(MQTT_URL, {
  username: process.env.MQTT_USERNAME,
  password: process.env.MQTT_PASSWORD,
  clientId:
    process.env.MQTT_CLIENT_ID ||
    `sprayer-hmi-${randomUUID().slice(0, 8)}`,
  clean: true,
  reconnectPeriod: 5000,
  connectTimeout: 30000
});

const VALID_MACHINE_MODES = new Set([
  "STANDBY",
  "CIRCULATE",
  "FILL"
]);

const REQUIRED_RAW_FIELDS = [
  "pressure",
  "flow_lpm",
  "battery_pct",
  "speed_mps"
];

const CONDITION_HISTORY_LIMIT_SAFE = Math.max(
  50,
  CONDITION_HISTORY_LIMIT
);

let connectionStatus = "DISCONNECTED";
let latestTelemetry = null;
let latestStatus = null;
let lastTelemetryReceivedAt = null;
let telemetryWatchStartedAt = null;
let telemetryIsStale = true;

const activeConditions = new Map();
const conditionHistory = [];

// HMI permissives are a second layer only; the ESP32 must enforce
// all critical cutoffs locally, even when MQTT/Wi-Fi is unavailable.
const PRESSURE_WARNING_PSI = 40;
const PRESSURE_CUTOFF_PSI = 45;
const BATTERY_WARNING_PERCENT = 25;
const BATTERY_CUTOFF_PERCENT = 20;
const activeEsp32Trips = new Set();
let safetyState = {
  pressureWarning: false,
  pressureCutoff: false,
  batteryWarning: false,
  batteryCutoff: false,
  sprayPermitted: false,
  thresholds: {
    pressureWarningPsi: PRESSURE_WARNING_PSI,
    pressureCutoffPsi: PRESSURE_CUTOFF_PSI,
    batteryWarningPercent: BATTERY_WARNING_PERCENT,
    batteryCutoffPercent: BATTERY_CUTOFF_PERCENT
  }
};

function emitSafetyState() {
  io.emit("safety_state", safetyState);
}

function updateSafetyFromTelemetry(telemetry) {
  const pressure = telemetry && telemetry.pressure;
  const battery = telemetry && telemetry.battery_level;
  const validPressure = isFiniteNumber(pressure) && pressure >= 0;
  const validBattery = isFiniteNumber(battery) && battery >= 0 && battery <= 100;

  safetyState = {
    pressureWarning: validPressure && pressure >= PRESSURE_WARNING_PSI,
    pressureCutoff: validPressure && pressure >= PRESSURE_CUTOFF_PSI,
    batteryWarning: validBattery && battery <= BATTERY_WARNING_PERCENT && battery > BATTERY_CUTOFF_PERCENT,
    batteryCutoff: validBattery && battery <= BATTERY_CUTOFF_PERCENT,
    sprayPermitted: validPressure && validBattery &&
      pressure < PRESSURE_CUTOFF_PSI && battery > BATTERY_CUTOFF_PERCENT &&
      activeEsp32Trips.size === 0 && !telemetryIsStale,
    thresholds: {
      pressureWarningPsi: PRESSURE_WARNING_PSI,
      pressureCutoffPsi: PRESSURE_CUTOFF_PSI,
      batteryWarningPercent: BATTERY_WARNING_PERCENT,
      batteryCutoffPercent: BATTERY_CUTOFF_PERCENT
    }
  };

  if (validPressure && pressure >= PRESSURE_CUTOFF_PSI) {
    recordCondition({ key: "SAFE-PRESSURE", id: "SAFE-PRESSURE", code: "SAFE-PRESSURE", category: "SAFETY", severity: "FAULT", title: "Critical Overpressure", message: `Pressure is ${pressure} PSI. Spray operation is blocked at ${PRESSURE_CUTOFF_PSI} PSI.`, source: "pressure", value: pressure, unit: "PSI" });
  } else {
    clearCondition("SAFE-PRESSURE", "Pressure is below the critical cutoff.");
  }

  if (validBattery && battery <= BATTERY_CUTOFF_PERCENT) {
    recordCondition({ key: "SAFE-BATTERY", id: "SAFE-BATTERY", code: "SAFE-BATTERY", category: "SAFETY", severity: "FAULT", title: "Critical Low Battery", message: `Battery is ${battery}%. Spray operation is blocked at or below ${BATTERY_CUTOFF_PERCENT}%.`, source: "battery", value: battery, unit: "%" });
  } else {
    clearCondition("SAFE-BATTERY", "Battery is above the critical cutoff.");
  }

  emitSafetyState();
}

// =====================================================
// CONDITION MANAGEMENT
// =====================================================

function emitConditionSnapshot() {
  io.emit("hmi_conditions", {
    active: Array.from(activeConditions.values()),
    history: conditionHistory
  });
}

function recordCondition({
  key,
  id,
  code,
  category,
  severity,
  title,
  message,
  source,
  value = null,
  unit = null,
  relatedCondition = null
}) {
  const existing = activeConditions.get(key);

  if (existing) {
    const changed =
      existing.value !== value ||
      existing.message !== message;

    existing.value = value;
    existing.message = message;
    existing.lastUpdatedAt = new Date().toISOString();

    if (changed) {
      io.emit("hmi_condition", existing);
    }

    return existing;
  }

  const now = new Date().toISOString();

  const condition = {
    eventId: randomUUID(),
    id,
    code,
    category,
    severity,
    title,
    message,
    source,
    value,
    unit,
    status: "ACTIVE",
    relatedCondition,
    triggeredAt: now,
    lastUpdatedAt: now,
    acknowledgedAt: null,
    clearedAt: null
  };

  activeConditions.set(key, condition);
  conditionHistory.unshift(condition);

  if (
    conditionHistory.length >
    CONDITION_HISTORY_LIMIT_SAFE
  ) {
    conditionHistory.length =
      CONDITION_HISTORY_LIMIT_SAFE;
  }

  io.emit("hmi_condition", condition);
  io.emit("hmi_notification", condition);

  emitConditionSnapshot();

  return condition;
}

function clearCondition(key, clearMessage) {
  const condition = activeConditions.get(key);

  if (!condition) return null;

  condition.status = "CLEARED";
  condition.clearedAt = new Date().toISOString();
  condition.lastUpdatedAt = condition.clearedAt;

  if (clearMessage) {
    condition.clearMessage = clearMessage;
  }

  activeConditions.delete(key);

  io.emit("hmi_condition", condition);
  emitConditionSnapshot();

  return condition;
}

function acknowledgeCondition(eventId) {
  const condition = conditionHistory.find(
    item => item.eventId === eventId
  );

  if (!condition) return null;
  if (condition.acknowledgedAt) return condition;

  condition.acknowledgedAt = new Date().toISOString();
  condition.lastUpdatedAt = condition.acknowledgedAt;
  condition.acknowledgedBy = "HMI";

  io.emit("hmi_condition", condition);
  emitConditionSnapshot();

  return condition;
}

function setCommunicationCondition(disconnected) {
  if (disconnected) {
    recordCondition({
      key: "COM-001",
      id: "COM-001",
      code: "COM-001",
      category: "COMMUNICATION",
      severity: "FAULT",
      title: "MQTT Disconnected",
      message:
        "The backend is not connected to the sprayer MQTT broker.",
      source: "mqtt_connection"
    });
  } else {
    clearCondition(
      "COM-001",
      "MQTT connection restored."
    );
  }
}

// =====================================================
// TELEMETRY PROCESSING
// =====================================================

function isFiniteNumber(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function mapTelemetry(raw) {
  const mode =
    typeof raw.mode === "string"
      ? raw.mode.toUpperCase()
      : "STANDBY";

  const normalizedMode =
    VALID_MACHINE_MODES.has(mode)
      ? mode
      : null;

  return {
    pressure: raw.pressure,
    pressure_target: raw.pressure_target,

    battery_voltage: raw.battery_v,
    battery_level: raw.battery_pct,

    vehicle_speed: isFiniteNumber(raw.speed_mps)
      ? raw.speed_mps * 3.6
      : raw.speed_mps,

    flow_rate: raw.flow_lpm,
    flow_target: raw.flow_target_lpm,

    setpoint: raw.setpoint_l_per_m,
    applied_rate: raw.applied_l_per_m,

    total_litres: raw.litres,
    distance_m: raw.distance,

    pump_temperature: raw.temp_c,

    // The current ESP32 firmware publishes these as 0 or 1.
    // Convert them to booleans for the frontend.
    pump: raw.pump === true || raw.pump === 1,
    spray_active: raw.spray === true || raw.spray === 1,
    flow_limited:
      raw.flow_limited === true ||
      raw.flow_limited === 1,

    machine_mode: normalizedMode || "STANDBY",

    esp32_trip: raw.trip,

    receivedAt: new Date().toISOString(),
    dataQuality: "VALID"
  };
}

function validateAndProcessTelemetry(raw) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  ) {
    recordCondition({
      key: "DATA-001",
      id: "DATA-001",
      code: "DATA-001",
      category: "DATA",
      severity: "FAULT",
      title: "Invalid Telemetry Payload",
      message:
        "The telemetry payload must be a JSON object.",
      source: "telemetry"
    });

    return;
  }

  const missing = REQUIRED_RAW_FIELDS.filter(
    field =>
      !Object.prototype.hasOwnProperty.call(raw, field)
  );

  const invalid = [];

  const numericFields = [
    "pressure",
    "flow_lpm",
    "battery_pct",
    "speed_mps"
  ];

  for (const field of numericFields) {
    if (
      Object.prototype.hasOwnProperty.call(raw, field) &&
      (
        !isFiniteNumber(raw[field]) ||
        raw[field] < 0
      )
    ) {
      invalid.push(field);
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(raw, "battery_pct") &&
    (
      raw.battery_pct < 0 ||
      raw.battery_pct > 100
    )
  ) {
    if (!invalid.includes("battery_pct")) {
      invalid.push("battery_pct");
    }
  }

  // Missing fields
  for (const field of missing) {
    recordCondition({
      key: `DATA-MISSING:${field}`,
      id: "DATA-MISSING",
      code: "DATA-MISSING",
      category: "DATA",
      severity: "FAULT",
      title: "Required Telemetry Field Missing",
      message:
        `The ESP32 telemetry packet is missing ${field}.`,
      source: field
    });
  }

  for (
    const field of REQUIRED_RAW_FIELDS.filter(
      field => !missing.includes(field)
    )
  ) {
    clearCondition(
      `DATA-MISSING:${field}`,
      `${field} is present again.`
    );
  }

  // Invalid fields
  for (const field of invalid) {
    recordCondition({
      key: `DATA-INVALID:${field}`,
      id: "DATA-INVALID",
      code: "DATA-INVALID",
      category: "DATA",
      severity: "FAULT",
      title: "Invalid Telemetry Value",
      message:
        `The ESP32 ${field} value is not a valid non-negative reading.`,
      source: field,
      value: raw[field]
    });
  }

  for (
    const field of REQUIRED_RAW_FIELDS.filter(
      field => !invalid.includes(field)
    )
  ) {
    clearCondition(
      `DATA-INVALID:${field}`,
      `${field} is valid again.`
    );
  }

  const valid =
    missing.length === 0 &&
    invalid.length === 0;

  if (valid) {
    lastTelemetryReceivedAt = Date.now();
    telemetryIsStale = false;

    clearCondition(
      "COM-002",
      "Complete, valid telemetry reception has resumed."
    );

    clearCondition(
      "DATA-001",
      "Valid telemetry JSON has been received."
    );
  }

  const mapped = mapTelemetry(raw);

  if (latestTelemetry && !valid) {
    latestTelemetry = {
      ...latestTelemetry,
      ...mapped,
      dataQuality: "DEGRADED"
    };
  } else {
    latestTelemetry = {
      ...mapped,
      dataQuality: valid ? "VALID" : "DEGRADED"
    };
  }

  updateSafetyFromTelemetry(latestTelemetry);
  io.emit("telemetry", latestTelemetry);
  emitConditionSnapshot();
}

// =====================================================
// MACHINE STATUS
// =====================================================

function handleMachineStatus(data) {
  if (
    !data ||
    typeof data !== "object" ||
    Array.isArray(data)
  ) {
    return;
  }

  const modeValue =
    data.machine_mode || data.mode;

  if (typeof modeValue === "string") {
    const mode = modeValue.toUpperCase();

    if (!VALID_MACHINE_MODES.has(mode)) {
      recordCondition({
        key: "DATA-004",
        id: "DATA-004",
        code: "DATA-004",
        category: "DATA",
        severity: "FAULT",
        title: "Invalid Machine Mode",
        message:
          `Unrecognised ESP32 operating mode: ${modeValue}.`,
        source: "mode",
        value: modeValue
      });

      return;
    }

    clearCondition(
      "DATA-004",
      "A valid machine mode has been received."
    );
  }

  latestStatus = data;

  io.emit("machine_status", data);
}

// =====================================================
// ESP32 ALARMS
// =====================================================

function handleEsp32Alarm(data) {
  const items = Array.isArray(data) ? data : [data];
  const normalized = [];

  for (const item of items) {
    const alarm = typeof item === "string" ? { code: item } : item;
    if (!alarm || typeof alarm !== "object") continue;

    const rawCode = alarm.code || alarm.alarm || alarm.name || alarm.type || alarm.trip || "";
    const code = String(rawCode).trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (!code) continue;

    const inactive = alarm.active === false || ["CLEARED", "INACTIVE", "RESET"].includes(String(alarm.status || "").toUpperCase());
    if (code.startsWith("TRIP_")) {
      if (inactive) activeEsp32Trips.delete(code);
      else activeEsp32Trips.add(code);

      const key = `ESP32:${code}`;
      if (inactive) {
        clearCondition(key, `ESP32 reported ${code} cleared.`);
      } else {
        recordCondition({ key, id: code, code, category: "ESP32_TRIP", severity: "FAULT", title: code.replace(/_/g, " "), message: `Trip reported by ESP32: ${code}.`, source: "esp32" });
      }
    }

    normalized.push({ ...alarm, code });
  }

  io.emit("esp32_alarm", Array.isArray(data) ? normalized : (normalized[0] || data));
  emitSafetyState();
}

// =====================================================
// HMI COMMANDS TO ESP32
// =====================================================

function validateHmiCommand(request) {
  const command = request.command;
  const pressure = latestTelemetry && latestTelemetry.pressure;
  const battery = latestTelemetry && latestTelemetry.battery_level;
  const fresh = !telemetryIsStale && lastTelemetryReceivedAt &&
    Date.now() - lastTelemetryReceivedAt <= TELEMETRY_STALE_TIMEOUT_MS;

  // Emergency standby and zero setpoint must remain available during stale data.
  if (command === "standby" || (command === "setpoint" && Number(request.value) === 0)) return;

  if (!fresh || !latestTelemetry || latestTelemetry.dataQuality !== "VALID") {
    throw new Error("Fresh, complete telemetry is required before operating the sprayer.");
  }

  if (command === "setpoint") {
    const setpoint = Number(request.value);
    if (!Number.isFinite(setpoint) || setpoint < 0.1 || setpoint > 10) {
      throw new Error("Spray application rate must be between 0.1 and 10 L/m².");
    }
    if (!isFiniteNumber(pressure) || pressure >= PRESSURE_CUTOFF_PSI) {
      throw new Error("Pressure is at or above 45 PSI. Spray is blocked by the critical pressure cutoff.");
    }
    if (!isFiniteNumber(battery) || battery <= BATTERY_CUTOFF_PERCENT) {
      throw new Error("Battery is at or below 20%. Spray is prohibited until charged and safely reset.");
    }
    if (battery <= BATTERY_WARNING_PERCENT && request.confirmLowBattery !== true) {
      throw new Error("Battery is between 21% and 25%. Operator confirmation is required before spraying.");
    }
    const telemetryTrip = latestTelemetry && String(latestTelemetry.esp32_trip || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
    const hasTelemetryTrip = telemetryTrip && !["NONE", "0", "FALSE", "NULL"].includes(telemetryTrip);
    if (activeEsp32Trips.size > 0 || hasTelemetryTrip) {
      const trips = Array.from(activeEsp32Trips);
      if (hasTelemetryTrip && !trips.includes(telemetryTrip)) trips.push(telemetryTrip);
      throw new Error(`ESP32 safety trip active: ${trips.join(", ")}. Clear the fault before spraying.`);
    }
  }

  if (["circulate", "fill"].includes(command)) {
    if (activeEsp32Trips.size > 0) {
      const allowedFillWithLowWater = command === "fill" &&
        Array.from(activeEsp32Trips).every(code => code === "TRIP_WATER_LOW");
      if (!allowedFillWithLowWater) {
        throw new Error(`ESP32 safety trip active: ${Array.from(activeEsp32Trips).join(", ")}.`);
      }
    }
    if (isFiniteNumber(pressure) && pressure >= PRESSURE_CUTOFF_PSI) {
      throw new Error("Pressure is at or above 45 PSI. Operating commands are blocked.");
    }
  }

  if (command === "reset") {
    if (!isFiniteNumber(pressure) || !isFiniteNumber(battery) ||
        pressure >= PRESSURE_WARNING_PSI || battery <= BATTERY_WARNING_PERCENT) {
      throw new Error("Safety reset requires pressure below 40 PSI and battery above 25%.");
    }
  }
}

function publishDeviceCommand(command, value) {
  const commandTopics = {
    standby: TOPICS.standby,
    circulate: TOPICS.circulate,
    fill: TOPICS.fill,
    reset: TOPICS.reset
  };

  let topic;
  let payload;

  if (command === "setpoint") {
    if (
      !isFiniteNumber(value) ||
      value < 0
    ) {
      throw new Error(
        "Setpoint must be a finite number greater than or equal to zero."
      );
    }

    topic = TOPICS.setpoint;
    payload = String(value);
  } else {
    topic = commandTopics[command];

    if (!topic) {
      throw new Error("Unsupported command.");
    }

    payload = "1";
  }

  if (
    connectionStatus !== "CONNECTED" ||
    !mqttClient.connected
  ) {
    throw new Error(
      "MQTT is disconnected. The command was not published."
    );
  }

  return new Promise((resolve, reject) => {
    mqttClient.publish(
      topic,
      payload,
      {
        qos: 1,
        retain: false
      },
      error => {
        if (error) {
          return reject(error);
        }

        console.log(
          `HMI command published: ${topic} = ${payload}`
        );

        resolve({
          success: true,
          message: "Command published to MQTT broker.",
          topic
        });
      }
    );
  });
}

// =====================================================
// HTTP ENDPOINTS
// =====================================================

app.get("/", (req, res) => {
  res.json({
    application: "Smart Sprayer Backend",
    status: "running",
    mqtt: connectionStatus
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    backend: "ONLINE",
    mqtt: connectionStatus,

    telemetryLastReceivedAt:
      lastTelemetryReceivedAt
        ? new Date(
            lastTelemetryReceivedAt
          ).toISOString()
        : null,

    telemetryStaleTimeoutMs:
      TELEMETRY_STALE_TIMEOUT_MS,

    telemetryStale: telemetryIsStale
  });
});

app.get("/api/telemetry", (req, res) => {
  res.json(
    latestTelemetry || {
      message: "No telemetry received yet"
    }
  );
});

app.get("/api/conditions", (req, res) => {
  res.json({
    active: Array.from(activeConditions.values()),
    history: conditionHistory
  });
});

app.get("/api/events", (req, res) => {
  res.json(conditionHistory);
});

app.post(
  "/api/conditions/:eventId/acknowledge",
  (req, res) => {
    const condition = acknowledgeCondition(
      req.params.eventId
    );

    if (!condition) {
      return res.status(404).json({
        error: "Condition event not found."
      });
    }

    res.json({
      message: "Condition acknowledged.",
      condition
    });
  }
);

// =====================================================
// MQTT CONNECTION AND SUBSCRIPTIONS
// =====================================================

mqttClient.on("connect", () => {
  console.log("Connected to EMQX successfully!");

  connectionStatus = "CONNECTED";
  telemetryWatchStartedAt = Date.now();

  setCommunicationCondition(false);

  io.emit("mqtt_connection", {
    status: connectionStatus
  });

  const subscriptions = [
    TOPICS.telemetry,
    TOPICS.status,
    TOPICS.alarms,
    TOPICS.commandAck
  ];

  mqttClient.subscribe(
    subscriptions,
    { qos: 1 },
    error => {
      if (error) {
        console.error(
          "MQTT subscription error:",
          error.message
        );

        return;
      }

      console.log("Subscribed to device topics:");

      subscriptions.forEach(topic => {
        console.log(` - ${topic}`);
      });
    }
  );
});

// =====================================================
// MQTT MESSAGE HANDLER
// =====================================================

mqttClient.on("message", (topic, message) => {
  const text = message.toString();

  let data;

  try {
    data = JSON.parse(text);
  } catch (error) {
    console.error(
      `Invalid JSON on ${topic}:`,
      error.message
    );

    if (topic === TOPICS.telemetry) {
      recordCondition({
        key: "DATA-001",
        id: "DATA-001",
        code: "DATA-001",
        category: "DATA",
        severity: "FAULT",
        title: "Invalid Telemetry JSON",
        message:
          "The telemetry message could not be parsed as JSON.",
        source: "telemetry"
      });
    }

    return;
  }

  if (topic === TOPICS.telemetry) {
    clearCondition(
      "DATA-001",
      "Valid telemetry JSON has been received."
    );

    validateAndProcessTelemetry(data);
  } else if (topic === TOPICS.status) {
    handleMachineStatus(data);
  } else if (topic === TOPICS.alarms) {
    handleEsp32Alarm(data);
  } else if (topic === TOPICS.commandAck) {
    io.emit("command_ack", data);
  }
});

// =====================================================
// MQTT ERROR AND RECONNECTION EVENTS
// =====================================================

mqttClient.on("error", error => {
  console.error("MQTT error:", error.message);
});

mqttClient.on("reconnect", () => {
  console.log("Reconnecting to EMQX...");
});

mqttClient.on("close", () => {
  connectionStatus = "DISCONNECTED";

  setCommunicationCondition(true);

  io.emit("mqtt_connection", {
    status: connectionStatus
  });

  console.log("MQTT connection closed");
});

mqttClient.on("offline", () => {
  connectionStatus = "DISCONNECTED";

  setCommunicationCondition(true);

  io.emit("mqtt_connection", {
    status: connectionStatus
  });
});

// =====================================================
// SOCKET.IO CONNECTION
// =====================================================

io.on("connection", socket => {
  console.log("HMI connected:", socket.id);

  socket.emit("mqtt_connection", {
    status: connectionStatus
  });

  if (latestTelemetry) {
    socket.emit("telemetry", latestTelemetry);
  }

  if (latestStatus) {
    socket.emit("machine_status", latestStatus);
  }

  socket.emit("hmi_conditions", {
    active: Array.from(activeConditions.values()),
    history: conditionHistory
  });
  socket.emit("safety_state", safetyState);

  socket.on(
    "hmi_command",
    async (request, acknowledge) => {
      const reply =
        typeof acknowledge === "function"
          ? acknowledge
          : () => {};

      if (
        !request ||
        typeof request !== "object"
      ) {
        reply({
          success: false,
          message: "Invalid command request."
        });

        return;
      }

      try {
        validateHmiCommand(request);
        const result = await publishDeviceCommand(
          request.command,
          request.value
        );

        reply(result);
      } catch (error) {
        console.error(
          "HMI command rejected:",
          error.message
        );

        reply({
          success: false,
          message: error.message
        });
      }
    }
  );

  socket.on("disconnect", () => {
    console.log("HMI disconnected:", socket.id);
  });
});

// =====================================================
// TELEMETRY FRESHNESS MONITOR
// =====================================================

setInterval(() => {
  if (
    connectionStatus !== "CONNECTED" ||
    telemetryIsStale
  ) {
    return;
  }

  const referenceTime = Math.max(
    lastTelemetryReceivedAt || 0,
    telemetryWatchStartedAt || 0
  );

  if (!referenceTime) return;

  const age = Date.now() - referenceTime;

  if (age > TELEMETRY_STALE_TIMEOUT_MS) {
    telemetryIsStale = true;
    safetyState.sprayPermitted = false;
    emitSafetyState();

    recordCondition({
      key: "COM-002",
      id: "COM-002",
      code: "COM-002",
      category: "COMMUNICATION",
      severity: "FAULT",
      title: "Telemetry Stale",
      message:
        `No complete valid telemetry packet received within ${Math.round(
          TELEMETRY_STALE_TIMEOUT_MS / 1000
        )} seconds.`,
      source: "telemetry",
      value: Math.round(age / 1000),
      unit: "seconds"
    });
  }
}, 1000);

// =====================================================
// START SERVER
// =====================================================

server.listen(PORT, () => {
  console.log(
    `Smart Sprayer backend running on port ${PORT}`
  );

  console.log(
    `Device topic prefix: ${DEVICE_ID}`
  );

  console.log(
    `Telemetry stale timeout: ${
      TELEMETRY_STALE_TIMEOUT_MS / 1000
    } seconds`
  );
});

// =====================================================
// GRACEFUL SHUTDOWN
// =====================================================

function shutdown(signal) {
  console.log(
    `${signal} received. Closing connections...`
  );

  mqttClient.end(false, () => {
    server.close(() => process.exit(0));
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));