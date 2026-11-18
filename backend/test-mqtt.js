
require("dotenv").config();

const mqtt = require("mqtt");

const host = process.env.MQTT_HOST;
const port = process.env.MQTT_PORT || 8883;
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;

if (!host || !username || !password) {
  console.error("Missing MQTT configuration in .env");
  process.exit(1);
}

const client = mqtt.connect(`mqtts://${host}:${port}`, {
  username,
  password,
  clientId: `sprayer-test-${Date.now()}`,
  clean: true,
  connectTimeout: 30000,
  reconnectPeriod: 0
});

const telemetryTopic = "sprayer/001/telemetry";
const statusTopic = "sprayer/001/status";

const baseTelemetry = {
  pressure: 32.8,
  flow_rate: 3.2,
  tank_level: "HIGH",
  battery_level: 91,
  vehicle_speed: 12.5
};

const tests = {
  normal: {
    topic: telemetryTopic,
    payload: baseTelemetry
  },

  pressureWarning: {
    topic: telemetryTopic,
    payload: { ...baseTelemetry, pressure: 36 }
  },

  pressureHigh: {
    topic: telemetryTopic,
    payload: { ...baseTelemetry, pressure: 42 }
  },

  pressureClear: {
    topic: telemetryTopic,
    payload: { ...baseTelemetry, pressure: 32 }
  },

  invalidValue: {
    topic: telemetryTopic,
    payload: { ...baseTelemetry, battery_level: 145 }
  },

  missingField: {
    topic: telemetryTopic,
    payload: {
      pressure: 32.8,
      flow_rate: 3.2,
      tank_level: "HIGH",
      battery_level: 91
    }
  },

  invalidMode: {
    topic: statusTopic,
    payload: { machine_mode: "UNKNOWN" }
  },

  validMode: {
    topic: statusTopic,
    payload: { machine_mode: "SPRAY" }
  },

  badJson: {
    topic: telemetryTopic,
    payload: "{invalid-json}"
  }
};

const selectedTest = process.argv[2];

if (!tests[selectedTest]) {
  console.log("\nAvailable tests:");
  Object.keys(tests).forEach(name => console.log(`- ${name}`));
  console.log("\nExample: node test-mqtt.js pressureWarning");
  process.exit(0);
}

client.on("connect", () => {
  const test = tests[selectedTest];

  const message = typeof test.payload === "string"
    ? test.payload
    : JSON.stringify(test.payload);

  console.log(`Running test: ${selectedTest}`);
  console.log(`Publishing to: ${test.topic}`);
  console.log(`Payload: ${message}`);

  client.publish(test.topic, message, { qos: 1 }, error => {
    if (error) {
      console.error("Publish failed:", error.message);
    } else {
      console.log("\nTest message published successfully.");
    }

    client.end();
  });
});

client.on("error", error => {
  console.error("MQTT test connection error:", error.message);
  client.end(true);
});
