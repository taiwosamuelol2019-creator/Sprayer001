
"use client";

import { useEffect, useRef, useState } from "react";
import { socket } from "@/lib/socket";

type MachineMode = "STANDBY" | "CIRCULATE" | "FILL";
type OperatingState =
  | MachineMode
  | "SPRAY"
  | "TRIP"
  | "UNKNOWN";

type Command =
  | "setpoint"
  | "standby"
  | "circulate"
  | "fill"
  | "reset";

type Tab =
  | "Dashboard"
  | "Control"
  | "Alarms"
  | "Trends"
  | "Settings";

type Telemetry = {
  pressure: number;
  pressure_target?: number;
  battery_voltage?: number;
  battery_level: number;
  flow_rate: number;
  flow_target?: number;
  setpoint?: number;
  applied_rate?: number;
  total_litres?: number;
  distance_m?: number;
  pump_temperature?: number;
  pump?: boolean;
  spray_active?: boolean;
  flow_limited?: boolean;
  machine_mode: MachineMode;
  esp32_trip?: string;
  receivedAt: string;
  dataQuality?: "VALID" | "DEGRADED";
};

type HmiCondition = {
  eventId: string;
  id: string;
  code: string;
  category: string;
  severity: string;
  title: string;
  message: string;
  source?: string;
  value?: number | string | null;
  unit?: string | null;
  status: string;
  triggeredAt: string;
  lastUpdatedAt?: string;
  acknowledgedAt?: string | null;
  clearedAt?: string | null;
};

type HmiConditionSnapshot = {
  active: HmiCondition[];
  history: HmiCondition[];
};

type SafetyState = {
  pressureWarning: boolean;
  pressureCutoff: boolean;
  batteryWarning: boolean;
  batteryCutoff: boolean;
  sprayPermitted: boolean;
  thresholds?: {
    pressureWarningPsi: number;
    pressureCutoffPsi: number;
    batteryWarningPercent: number;
    batteryCutoffPercent: number;
  };
};

type Notice = {
  title: string;
  message: string;
};

type Esp32Alarm = Record<string, unknown>;

const TELEMETRY_STALE_TIMEOUT_MS = 45000;

const PRESSURE_WARNING_PSI = 40;
const PRESSURE_CUTOFF_PSI = 45;
const BATTERY_WARNING_PERCENT = 25;
const BATTERY_CUTOFF_PERCENT = 20;

// Confirm these values against the ESP32 firmware.
const SETPOINT_MIN = 0.1;
const SETPOINT_MAX = 10;
const SETPOINT_STEP = 0.1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function normalizeAlarmCode(alarm: Esp32Alarm): string {
  const raw =
    alarm.code ??
    alarm.alarm ??
    alarm.name ??
    alarm.type ??
    alarm.trip ??
    "";

  return String(raw)
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
}

function alarmIsActive(alarm: Esp32Alarm): boolean {
  if (alarm.active === false) return false;

  const status = String(alarm.status ?? "").toUpperCase();

  return ![
    "CLEARED",
    "INACTIVE",
    "RESET"
  ].includes(status);
}

function isTripActive(trip?: string): boolean {
  if (!trip) return false;

  return ![
    "NONE",
    "0",
    "FALSE",
    "",
    "NULL"
  ].includes(trip.trim().toUpperCase());
}

export default function Home() {
  const [activeTab, setActiveTab] = useState<Tab>("Dashboard");
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  useEffect(() => {
    const savedTheme = window.localStorage.getItem("smart-sprayer-theme");
    if (savedTheme === "light" || savedTheme === "dark") {
      setTheme(savedTheme);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("smart-sprayer-theme", theme);
  }, [theme]);

  const [telemetry, setTelemetry] =
    useState<Telemetry | null>(null);

  const [mqttStatus, setMqttStatus] = useState("UNKNOWN");
  const [socketConnected, setSocketConnected] = useState(false);
  const [socketError, setSocketError] = useState("");
  const [dataIsStale, setDataIsStale] = useState(false);

  const [lastValidTelemetryAt, setLastValidTelemetryAt] =
    useState<number | null>(null);

  const [hmiConditions, setHmiConditions] =
    useState<HmiCondition[]>([]);

  const [conditionHistory, setConditionHistory] =
    useState<HmiCondition[]>([]);

  const [esp32Alarms, setEsp32Alarms] =
    useState<Esp32Alarm[]>([]);

  const [safetyState, setSafetyState] =
    useState<SafetyState>({
      pressureWarning: false,
      pressureCutoff: false,
      batteryWarning: false,
      batteryCutoff: false,
      sprayPermitted: false
    });

  const [setpointInput, setSetpointInput] = useState("2.0");
  const [commandPending, setCommandPending] = useState(false);
  const [commandMessage, setCommandMessage] = useState("");
  const [popupNotice, setPopupNotice] =
    useState<Notice | null>(null);

  const [recoveryNotice, setRecoveryNotice] = useState(false);
  const previousLiveState = useRef(false);

  // =====================================================
  // SOCKET.IO
  // =====================================================

  useEffect(() => {
    const handleConnect = () => {
      console.log("Socket.IO connected:", socket.id);
      setSocketConnected(true);
      setSocketError("");
    };

    const handleDisconnect = (reason: string) => {
      console.log("Socket.IO disconnected:", reason);
      setSocketConnected(false);
      setMqttStatus("UNKNOWN");
    };

    const handleConnectError = (error: Error) => {
      console.error("Socket.IO error:", error.message);
      setSocketConnected(false);
      setSocketError(error.message);
    };

    const handleMqttConnection = (data: { status: string }) => {
      setMqttStatus(data.status);
    };

    const handleTelemetry = (data: Telemetry) => {
      console.log("Telemetry received:", data);
      setTelemetry(data);

      if (
        typeof data.setpoint === "number" &&
        Number.isFinite(data.setpoint)
      ) {
        setSetpointInput(data.setpoint.toFixed(1));
      }

      if (
        data.dataQuality === "VALID" &&
        data.receivedAt
      ) {
        const timestamp = new Date(data.receivedAt).getTime();

        if (Number.isFinite(timestamp)) {
          setLastValidTelemetryAt(timestamp);
        }
      }
    };

    const handleConditionSnapshot = (
      data: HmiConditionSnapshot
    ) => {
      setHmiConditions(data.active || []);
      setConditionHistory(data.history || []);
    };

    const handleCondition = (condition: HmiCondition) => {
      setHmiConditions(previous => {
        if (condition.status === "CLEARED") {
          return previous.filter(
            item => item.eventId !== condition.eventId
          );
        }

        const exists = previous.some(
          item => item.eventId === condition.eventId
        );

        if (exists) {
          return previous.map(item =>
            item.eventId === condition.eventId
              ? condition
              : item
          );
        }

        return [condition, ...previous];
      });

      setConditionHistory(previous => {
        const exists = previous.some(
          item => item.eventId === condition.eventId
        );

        if (exists) {
          return previous.map(item =>
            item.eventId === condition.eventId
              ? condition
              : item
          );
        }

        return [condition, ...previous].slice(0, 500);
      });
    };

    const handleSafetyState = (data: SafetyState) => {
      setSafetyState(data);
    };

    const handleEsp32Alarm = (data: unknown) => {
      const incoming = Array.isArray(data)
        ? data.map(item =>
            typeof item === "string"
              ? { code: item, title: item, message: `Trip reported by ESP32: ${item}` }
              : item
          ).filter(isRecord)
        : typeof data === "string"
          ? [{ code: data, title: data, message: `Trip reported by ESP32: ${data}` }]
          : isRecord(data)
            ? [data]
            : [];

      setEsp32Alarms(previous => {
        let next = [...previous];

        for (const alarm of incoming) {
          const code = normalizeAlarmCode(alarm);

          next = next.filter(
            item => normalizeAlarmCode(item) !== code
          );

          if (alarmIsActive(alarm)) {
            next.unshift(alarm);
          }
        }

        return next.slice(0, 50);
      });
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("connect_error", handleConnectError);
    socket.on("mqtt_connection", handleMqttConnection);
    socket.on("telemetry", handleTelemetry);
    socket.on("hmi_conditions", handleConditionSnapshot);
    socket.on("hmi_condition", handleCondition);
    socket.on("safety_state", handleSafetyState);
    socket.on("esp32_alarm", handleEsp32Alarm);

    socket.connect();

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("connect_error", handleConnectError);
      socket.off("mqtt_connection", handleMqttConnection);
      socket.off("telemetry", handleTelemetry);
      socket.off("hmi_conditions", handleConditionSnapshot);
      socket.off("hmi_condition", handleCondition);
      socket.off("safety_state", handleSafetyState);
      socket.off("esp32_alarm", handleEsp32Alarm);
      socket.disconnect();
    };
  }, []);

  // =====================================================
  // TELEMETRY FRESHNESS
  // =====================================================

  useEffect(() => {
    const timer = setInterval(() => {
      if (!lastValidTelemetryAt) {
        setDataIsStale(false);
        return;
      }

      const age = Date.now() - lastValidTelemetryAt;

      setDataIsStale(
        age < 0 || age > TELEMETRY_STALE_TIMEOUT_MS
      );
    }, 1000);

    return () => clearInterval(timer);
  }, [lastValidTelemetryAt]);

  const hasLiveData =
    telemetry !== null &&
    lastValidTelemetryAt !== null &&
    !dataIsStale &&
    socketConnected &&
    mqttStatus === "CONNECTED";

  const connectionIsHealthy =
    socketConnected && mqttStatus === "CONNECTED";

  // =====================================================
  // RECOVERY NOTICE
  // =====================================================

  useEffect(() => {
    if (hasLiveData && !previousLiveState.current) {
      setRecoveryNotice(true);

      const timer = setTimeout(() => {
        setRecoveryNotice(false);
      }, 4000);

      previousLiveState.current = true;

      return () => clearTimeout(timer);
    }

    if (!hasLiveData) {
      previousLiveState.current = false;
      setRecoveryNotice(false);
    }
  }, [hasLiveData]);

  // =====================================================
  // SENSOR VALUES AND ALARMS
  // =====================================================

  const pressure = telemetry?.pressure;
  const flowRate = telemetry?.flow_rate;
  const battery = telemetry?.battery_level;

  const activeAlarmCodes = esp32Alarms.map(
    normalizeAlarmCode
  );

  const hasAlarm = (...codes: string[]) =>
    activeAlarmCodes.some(activeCode =>
      codes.some(code => activeCode.includes(code))
    );

  const tankLowAlarm = hasAlarm(
    "TANK_LEVEL_LOW",
    "WATER_LOW",
    "LOW_WATER"
  );

  const tankHighAlarm = hasAlarm(
    "TANK_LEVEL_HIGH",
    "WATER_HIGH",
    "HIGH_WATER",
    "TANK_FULL"
  );

  const esp32BatteryAlarm = hasAlarm(
    "BATTERY_LOW",
    "LOW_BATTERY"
  );

  const esp32PressureAlarm = hasAlarm(
    "OVERPRESSURE",
    "HIGH_PRESSURE"
  );

  const telemetryTripActive = isTripActive(
    telemetry?.esp32_trip
  );

  const namedEsp32TripCodes = [
    "TRIP_OVERPRESSURE",
    "TRIP_PUMP_TEMP",
    "TRIP_WATER_LOW",
    "TRIP_SENSOR_FAULT"
  ];

  const activeEsp32TripCodes = Array.from(new Set([
    ...activeAlarmCodes.filter(code => code.startsWith("TRIP_")),
    ...(telemetryTripActive && telemetry?.esp32_trip
      ? [telemetry.esp32_trip.trim().toUpperCase().replace(/[\s-]+/g, "_")]
      : [])
  ]));

  const anyEsp32Trip =
    telemetryTripActive || activeEsp32TripCodes.length > 0 ||
    hasAlarm(...namedEsp32TripCodes);

  const pressureWarning =
    safetyState.pressureWarning ||
    (typeof pressure === "number" &&
      pressure >= PRESSURE_WARNING_PSI);

  const pressureCutoff =
    safetyState.pressureCutoff ||
    (typeof pressure === "number" &&
      pressure >= PRESSURE_CUTOFF_PSI);

  const batteryWarning =
    safetyState.batteryWarning ||
    (typeof battery === "number" &&
      battery <= BATTERY_WARNING_PERCENT &&
      battery > BATTERY_CUTOFF_PERCENT);

  const batteryCutoff =
    safetyState.batteryCutoff ||
    (typeof battery === "number" &&
      battery <= BATTERY_CUTOFF_PERCENT);

  const machineMode: MachineMode =
    telemetry?.machine_mode ?? "STANDBY";

  const operatingState: OperatingState =
    !hasLiveData
      ? "UNKNOWN"
      : anyEsp32Trip || pressureCutoff || batteryCutoff
        ? "TRIP"
        : telemetry?.spray_active
          ? "SPRAY"
          : machineMode;

  // =====================================================
  // CONNECTION NOTICE
  // =====================================================

  const getConnectionNotice = (): Notice | null => {
    if (!socketConnected) {
      return {
        title: "Backend connection lost",
        message:
          "The HMI cannot communicate with the backend. Sensor readings and machine commands are unavailable."
      };
    }

    if (mqttStatus !== "CONNECTED") {
      return {
        title: "MQTT connection unavailable",
        message:
          "The backend is connected, but the MQTT broker is not connected."
      };
    }

    if (!lastValidTelemetryAt) {
      return {
        title: "Waiting for sensor readings",
        message:
          "A complete and valid telemetry packet has not yet been received."
      };
    }

    if (dataIsStale) {
      return {
        title: "Sensor readings are stale",
        message:
          "No complete valid telemetry packet has arrived in the last 45 seconds. Operating commands are blocked."
      };
    }

    return null;
  };

  const connectionNotice = getConnectionNotice();

  // =====================================================
  // ACTION PERMISSIVES
  // =====================================================

  const getActionBlockers = (
    action: "SPRAY" | "CIRCULATE" | "FILL"
  ): string[] => {
    const blockers: string[] = [];

    if (!hasLiveData) {
      blockers.push(
        "Live telemetry is unavailable or stale. The machine state cannot be verified."
      );
      return blockers;
    }

    if (
      typeof battery !== "number" ||
      !Number.isFinite(battery) ||
      battery < 0 ||
      battery > 100
    ) {
      blockers.push("Battery reading is invalid or unavailable.");
    }

    if (
      typeof pressure !== "number" ||
      !Number.isFinite(pressure) ||
      pressure < 0
    ) {
      blockers.push("Pressure reading is invalid or unavailable.");
    }

    if (batteryCutoff || (typeof battery === "number" && battery <= BATTERY_CUTOFF_PERCENT)) {
      blockers.push(
        "Battery is at or below 20%. The battery trip is active and spraying is prohibited. Charge the battery and reset the safety trip."
      );
    }

    if (pressureCutoff || (typeof pressure === "number" && pressure >= PRESSURE_CUTOFF_PSI)) {
      blockers.push(
        "Pressure has reached 45 PSI. The critical pressure cutoff is active. Reduce pressure and reset the safety trip."
      );
    }

    const tripBlocksThisAction =
      anyEsp32Trip &&
      !(action === "FILL" &&
        activeEsp32TripCodes.length > 0 &&
        activeEsp32TripCodes.every(code => code === "TRIP_WATER_LOW"));

    if (tripBlocksThisAction) {
      blockers.push(
        `An ESP32 trip is active${activeEsp32TripCodes.length
          ? ` (${activeEsp32TripCodes.join(", ")})`
          : telemetry?.esp32_trip
            ? ` (${telemetry.esp32_trip})`
            : ""}. Clear the fault before operating.`
      );
    }

    if (esp32BatteryAlarm && action === "SPRAY") {
      blockers.push(
        "The ESP32 reports a low-battery alarm."
      );
    }

    if (
      (action === "SPRAY" || action === "CIRCULATE") &&
      (esp32PressureAlarm || pressureWarning)
    ) {
      if (typeof pressure === "number" && pressure >= PRESSURE_CUTOFF_PSI) {
        blockers.push("Critical pressure cutoff is active.");
      }
    }

    const activeBackendFaults = hmiConditions.filter(
      condition =>
        condition.status === "ACTIVE" &&
        condition.severity?.toUpperCase() === "FAULT" &&
        !(action === "FILL" && condition.code === "TRIP_WATER_LOW")
    );

    if (activeBackendFaults.length > 0) {
      blockers.push(
        ...activeBackendFaults.map(
          condition =>
            `${condition.title}: ${condition.message}`
        )
      );
    }

    if (
      (action === "SPRAY" || action === "CIRCULATE") &&
      tankLowAlarm
    ) {
      blockers.push(
        "Tank-water level is low. Spraying and circulation are blocked."
      );
    }

    if (action === "FILL" && tankHighAlarm) {
      blockers.push(
        "Tank is full. Filling is blocked to prevent overfilling."
      );
    }

    return blockers;
  };

  // =====================================================
  // SEND COMMAND
  // =====================================================

  const sendCommand = (
    command: Command,
    value?: number,
    confirmLowBattery = false
  ) => {
    if (!socketConnected || mqttStatus !== "CONNECTED") {
      setPopupNotice({
        title: "Command blocked",
        message:
          "The backend or MQTT broker is disconnected. Re-establish the connection before sending a command."
      });
      return;
    }

    setCommandPending(true);
    setCommandMessage("Sending command to backend...");

    socket.emit(
      "hmi_command",
      {
        command,
        ...(command === "setpoint" ? { value } : {}),
        ...(confirmLowBattery ? { confirmLowBattery: true } : {})
      },
      (response: {
        success?: boolean;
        message?: string;
        topic?: string;
      }) => {
        setCommandPending(false);

        if (!response?.success) {
          setCommandMessage("");

          setPopupNotice({
            title: "Command rejected",
            message:
              response?.message ||
              "The backend could not publish the command."
          });

          return;
        }

        setCommandMessage(
          `${response.message || "Command published."} Topic: ${response.topic || command}. Waiting for ESP32 confirmation.`
        );
      }
    );
  };

  // =====================================================
  // OPERATING ACTIONS
  // =====================================================

  const requestOperatingAction = (
    action: "SPRAY" | "CIRCULATE" | "FILL" | "STANDBY"
  ) => {
    if (action === "STANDBY") {
      sendCommand("standby");
      return;
    }

    const blockers = getActionBlockers(action);

    if (blockers.length > 0) {
      setPopupNotice({
        title: `${action} action blocked`,
        message: blockers.join("\n\n")
      });
      return;
    }

    if (action === "SPRAY") {
      const numericSetpoint = Number(setpointInput);

      if (
        !Number.isFinite(numericSetpoint) ||
        numericSetpoint < SETPOINT_MIN ||
        numericSetpoint > SETPOINT_MAX
      ) {
        setPopupNotice({
          title: "Invalid spray setpoint",
          message:
            `Enter a setpoint between ${SETPOINT_MIN.toFixed(1)} and ${SETPOINT_MAX.toFixed(1)} L/m².`
        });
        return;
      }

      let lowBatteryConfirmed = false;

      if (
        typeof battery === "number" &&
        battery <= BATTERY_WARNING_PERCENT &&
        battery > BATTERY_CUTOFF_PERCENT
      ) {
        const accepted = window.confirm(
          `LOW BATTERY WARNING\n\nBattery level is ${battery.toFixed(1)}%.\n\nBattery is at or below 25%. Do you want to proceed with spraying?\n\nAt 20% or below, the battery trip blocks spraying.`
        );

        if (!accepted) {
          return;
        }

        lowBatteryConfirmed = true;
      }

      sendCommand(
        "setpoint",
        numericSetpoint,
        lowBatteryConfirmed
      );

      return;
    }

    sendCommand(
      action === "CIRCULATE" ? "circulate" : "fill"
    );
  };

  const stopSpraying = () => {
    // A zero setpoint is a stop request.
    sendCommand("setpoint", 0);
  };

  const resetSafetyTrip = () => {
    if (!hasLiveData) {
      setPopupNotice({
        title: "Reset unavailable",
        message:
          "Fresh telemetry is required before a safety reset can be requested."
      });
      return;
    }

    if (
      typeof pressure !== "number" ||
      typeof battery !== "number" ||
      pressure >= PRESSURE_WARNING_PSI ||
      battery <= BATTERY_WARNING_PERCENT
    ) {
      setPopupNotice({
        title: "Safety reset blocked",
        message:
          "Before resetting, pressure must be below 40 PSI and battery must be above 25%."
      });
      return;
    }

    const accepted = window.confirm(
      "Confirm safety reset?\n\nOnly reset after checking that the machine is safe and the cause of the trip has been corrected."
    );

    if (accepted) {
      sendCommand("reset");
    }
  };

  // =====================================================
  // DISPLAY HELPERS
  // =====================================================

  const displayValue = (
    value: number | undefined,
    decimals = 0
  ) => {
    if (
      !hasLiveData ||
      value === undefined ||
      !Number.isFinite(value)
    ) {
      return "--";
    }

    return decimals > 0
      ? value.toFixed(decimals)
      : value.toString();
  };

  const activeConditionCount =
    hmiConditions.filter(
      condition => condition.status === "ACTIVE"
    ).length + esp32Alarms.length;

  // =====================================================
  // PAGE
  // =====================================================

  return (
    <main className={`hmi-theme theme-${theme} min-h-screen bg-slate-950 text-white`}>
      <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">

        {/* HEADER */}
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold tracking-[0.2em] text-emerald-400">
              SMART AGRICULTURE
            </p>

            <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
              Sprayer Control
            </h1>

            <p className="mt-1 text-sm text-slate-400">
              Machine ID: SPRAYER-001
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <div className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2">
              <svg
                aria-hidden="true"
                viewBox="0 0 32 18"
                className={`h-5 w-7 ${batteryCutoff ? "text-red-400" : batteryWarning ? "text-amber-400" : "text-emerald-400"}`}
                fill="none"
              >
                <rect x="1" y="2" width="26" height="14" rx="3" stroke="currentColor" strokeWidth="2" />
                <path d="M29 6v6" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                <rect x="4" y="5" width={typeof battery === "number" ? Math.max(0, Math.min(20, battery * 0.2)) : 0} height="8" rx="1" fill="currentColor" />
              </svg>
              <span className="text-sm font-bold tabular-nums">
                {displayValue(battery, 0)}%
              </span>
            </div>

            <button
              type="button"
              onClick={() => setTheme(current => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
              className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-semibold text-slate-200 transition hover:border-emerald-500"
            >
              <span aria-hidden="true">{theme === "dark" ? "☀" : "☾"}</span>
              {theme === "dark" ? "Light mode" : "Dark mode"}
            </button>

            <div className="flex flex-col items-end gap-1">
              <div
                className={`flex items-center gap-2 rounded-full border px-4 py-2 text-sm ${
                  connectionIsHealthy
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                    : "border-red-500/30 bg-red-500/10 text-red-300"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${connectionIsHealthy ? "bg-emerald-400" : "bg-red-400"}`} />
                {connectionIsHealthy ? "Backend & MQTT Connected" : "Connection Lost"}
              </div>
              <span className="text-xs text-slate-400">
                {!socketConnected
                  ? "Backend disconnected"
                  : mqttStatus !== "CONNECTED"
                    ? "Waiting for MQTT"
                    : hasLiveData
                      ? "Live sensor data"
                      : dataIsStale
                        ? "Sensor data is stale"
                        : "Waiting for telemetry"}
              </span>
            </div>
          </div>
        </header>

        {/* RECOVERY NOTICE */}
        {recoveryNotice && (
          <div
            role="status"
            className="fixed right-4 top-4 z-50 max-w-sm rounded-xl border border-emerald-500/30 bg-slate-900 p-4 shadow-2xl"
          >
            <p className="font-semibold text-emerald-300">
              Connection restored
            </p>
            <p className="mt-1 text-sm text-slate-300">
              Fresh sensor readings are being received again.
            </p>
          </div>
        )}

        {/* CONNECTION WARNING */}
        {connectionNotice && (
          <section
            role="alert"
            className={`mb-6 rounded-xl border p-4 ${
              !socketConnected || mqttStatus !== "CONNECTED"
                ? "border-red-500/30 bg-red-500/10"
                : "border-amber-500/30 bg-amber-500/10"
            }`}
          >
            <h2 className="font-semibold">
              {connectionNotice.title}
            </h2>

            <p className="mt-1 text-sm text-slate-300">
              {connectionNotice.message}
            </p>

            <p className="mt-3 text-xs text-slate-400">
              Backend: {socketConnected ? "Connected" : "Disconnected"}
              {" · "}
              MQTT: {mqttStatus}
            </p>

            {socketError && (
              <p className="mt-2 break-words text-xs text-red-300">
                {socketError}
              </p>
            )}
          </section>
        )}

        {/* SAFETY SUMMARY */}
        {hasLiveData && (
          <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SafetyCard
              label="Pressure warning"
              value="40 PSI"
              active={pressureWarning}
              critical={false}
            />

            <SafetyCard
              label="Pressure cutoff"
              value="45 PSI"
              active={pressureCutoff}
              critical
            />

            <SafetyCard
              label="Battery warning"
              value="25%"
              active={batteryWarning}
              critical={false}
            />

            <SafetyCard
              label="Battery cutoff"
              value="20%"
              active={batteryCutoff}
              critical
            />
          </section>
        )}

        {/* NAVIGATION */}
        <nav className="mb-6 flex gap-2 overflow-x-auto border-b border-slate-800 pb-3">
          {(
            [
              "Dashboard",
              "Control",
              "Alarms",
              "Trends",
              "Settings"
            ] as Tab[]
          ).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition ${
                activeTab === tab
                  ? "bg-emerald-500 text-slate-950"
                  : "text-slate-400 hover:bg-slate-800 hover:text-white"
              }`}
            >
              {tab}
            </button>
          ))}
        </nav>

        {/* DASHBOARD */}
        {activeTab === "Dashboard" && (
          <>
            {/* OPERATING STATE */}
            <section className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-900 p-4 sm:p-5">
              <div>
                <p className="text-sm text-slate-400">Operating state</p>
                <h2 className="mt-1 text-2xl font-bold text-emerald-400 sm:text-3xl">
                  {operatingState}
                </h2>
              </div>
              <div className="rounded-xl bg-slate-800 px-4 py-3 text-sm">
                <p className="text-slate-400">Machine connection</p>
                <p className={`mt-1 font-semibold ${connectionIsHealthy ? "text-emerald-300" : "text-red-300"}`}>
                  {connectionIsHealthy ? "Connected" : "Disconnected"}
                </p>
              </div>
            </section>

            {/* PRIMARY SENSOR READINGS */}
            <section className="mb-6">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold sm:text-xl">Live Sensor Monitoring</h2>
                <span className="text-xs text-slate-400">
                  {hasLiveData ? "● LIVE" : "○ NO LIVE DATA"}
                </span>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <SensorCard
                  label="Pressure"
                  value={displayValue(pressure, 1)}
                  unit="PSI"
                  icon="◉"
                  emphasis="pressure"
                  status={pressureCutoff ? "CRITICAL CUTOFF" : pressureWarning ? "HIGH PRESSURE WARNING" : "NORMAL"}
                  warning={pressureWarning}
                  critical={pressureCutoff}
                />
                <SensorCard
                  label="Flow Rate"
                  value={displayValue(flowRate, 1)}
                  unit="L/min"
                  icon="≋"
                  emphasis="flow"
                  status={hasLiveData ? "LIVE FLOW MEASUREMENT" : "AWAITING SENSOR DATA"}
                />
              </div>

              {!hasLiveData && (
                <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-300">
                  Live readings are unavailable. Displayed values are not current machine measurements.
                </p>
              )}
            </section>

            {/* SPRAY SETPOINT AND PRIMARY ACTION */}
            <section className="mb-5 rounded-2xl border border-emerald-500/30 bg-slate-900 p-5 shadow-lg sm:p-7">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.18em] text-emerald-400">Spray control</p>
                  <h2 className="mt-1 text-xl font-bold sm:text-2xl">Spray Setpoint</h2>
                  <p className="mt-1 text-sm text-slate-400">Enter the target application rate per square metre.</p>
                </div>
                <span className={`rounded-full px-3 py-1 text-xs font-bold ${hasLiveData && !pressureCutoff && !batteryCutoff ? "bg-emerald-500/10 text-emerald-300" : "bg-amber-500/10 text-amber-300"}`}>
                  {hasLiveData ? (safetyState.sprayPermitted ? "SYSTEM READY" : "CHECK PERMISSIVES") : "WAITING FOR DATA"}
                </span>
              </div>

              <div className="mx-auto mb-5 w-full max-w-xl">
                <label htmlFor="dashboard-setpoint" className="mb-2 block text-sm font-semibold text-slate-300">
                  Target application rate
                </label>
                <div className="flex items-stretch gap-3">
                  <input
                    id="dashboard-setpoint"
                    type="number"
                    inputMode="decimal"
                    min={SETPOINT_MIN}
                    max={SETPOINT_MAX}
                    step={SETPOINT_STEP}
                    value={setpointInput}
                    onChange={event => setSetpointInput(event.target.value)}
                    aria-label="Spray target application rate in litres per square metre"
                    className="h-16 min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-4 text-center text-3xl font-bold tabular-nums text-white outline-none transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20 sm:h-20 sm:text-4xl"
                  />
                  <div className="flex items-center rounded-xl border border-slate-700 bg-slate-800 px-4 text-sm font-semibold text-slate-300">
                    L/m²
                  </div>
                </div>
                <p className="mt-2 text-xs text-slate-500">
                  Allowed range: {SETPOINT_MIN.toFixed(1)}–{SETPOINT_MAX.toFixed(1)} L/m²
                </p>
                <button
                  onClick={() => requestOperatingAction("SPRAY")}
                  disabled={commandPending}
                  className="mt-4 flex min-h-14 w-full items-center justify-center gap-3 rounded-xl bg-emerald-500 px-5 py-3 text-base font-extrabold text-slate-950 shadow-lg shadow-emerald-950/20 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-16 sm:text-lg"
                >
                  <span aria-hidden="true" className="text-xl">▶</span>
                  {commandPending ? "SENDING COMMAND..." : "START SPRAYING"}
                </button>
              </div>

              <button
                onClick={stopSpraying}
                disabled={commandPending}
                className="mt-3 w-full rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm font-bold text-red-300 transition hover:bg-red-500/20 disabled:opacity-50"
              >
                STOP SPRAYING
              </button>

              {commandMessage && (
                <p role="status" className="mt-4 rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-slate-300">
                  {commandMessage}
                </p>
              )}
            </section>

            {/* SECONDARY MACHINE CONTROLS */}
            <section className="mb-5 rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <h2 className="mb-1 text-lg font-bold">Other Machine Controls</h2>
              <p className="mb-4 text-xs text-slate-400">
                Circulation and filling are checked against current machine conditions.
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <ActionButton
                  label="Circulate"
                  onClick={() => requestOperatingAction("CIRCULATE")}
                  disabled={commandPending}
                />
                <ActionButton
                  label="Fill"
                  onClick={() => requestOperatingAction("FILL")}
                  disabled={commandPending}
                />
                <div className="col-span-2 sm:col-span-1">
                  <ActionButton
                    label="Standby"
                    onClick={() => requestOperatingAction("STANDBY")}
                    disabled={commandPending}
                    style="red"
                  />
                </div>
              </div>
            </section>

            {/* ALARMS BELOW CONTROLS */}
            <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-bold">Alarms & Warnings</h2>
                <span className="text-xs text-slate-400">{activeConditionCount} active/recent</span>
              </div>

              {hmiConditions.length === 0 && esp32Alarms.length === 0 ? (
                <EmptyMessage message="No active backend conditions or ESP32 alarms." />
              ) : (
                <div className="space-y-3">
                  {hmiConditions.slice(0, 5).map(condition => (
                    <ConditionCard key={condition.eventId} condition={condition} />
                  ))}
                  {esp32Alarms.slice(0, 5).map((alarm, index) => (
                    <Esp32AlarmCard key={`dashboard-esp32-${index}`} alarm={alarm} />
                  ))}
                </div>
              )}

              <button
                onClick={() => setActiveTab("Alarms")}
                className="mt-4 text-sm font-semibold text-emerald-400 hover:text-emerald-300"
              >
                View all alarms and conditions →
              </button>
            </section>
          </>
        )}

        {/* CONTROL */}
        {activeTab === "Control" && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="mb-2 text-xl font-bold">
              Machine Control
            </h2>

            <p className="mb-6 text-sm text-slate-400">
              The backend checks the latest telemetry before sending commands.
              The ESP32 must independently enforce the same safety limits.
            </p>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <ActionButton
                label="Start Spray"
                onClick={() => requestOperatingAction("SPRAY")}
                disabled={commandPending}
                style="green"
              />

              <ActionButton
                label="Circulate"
                onClick={() => requestOperatingAction("CIRCULATE")}
                disabled={commandPending}
              />

              <ActionButton
                label="Fill"
                onClick={() => requestOperatingAction("FILL")}
                disabled={commandPending}
              />

              <ActionButton
                label="Standby"
                onClick={() => requestOperatingAction("STANDBY")}
                disabled={commandPending}
                style="red"
              />
            </div>

            <div className="mt-8 max-w-md">
              <h3 className="mb-3 font-semibold">
                Spray Setpoint
              </h3>

              <label
                htmlFor="control-setpoint"
                className="mb-2 block text-sm text-slate-400"
              >
                Target application rate (L/m²)
              </label>

              <div className="flex items-center gap-3">
                <input
                  id="control-setpoint"
                  type="number"
                  inputMode="decimal"
                  min={SETPOINT_MIN}
                  max={SETPOINT_MAX}
                  step={SETPOINT_STEP}
                  value={setpointInput}
                  onChange={event =>
                    setSetpointInput(event.target.value)
                  }
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-4 py-3 text-xl font-semibold text-white outline-none focus:border-emerald-500"
                />

                <button
                  onClick={() => requestOperatingAction("SPRAY")}
                  disabled={commandPending}
                  className="shrink-0 rounded-xl bg-emerald-500 px-5 py-3 font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
                >
                  Apply & Spray
                </button>
              </div>

              <button
                onClick={stopSpraying}
                disabled={commandPending}
                className="mt-3 text-sm font-medium text-red-300 hover:text-red-200 disabled:opacity-50"
              >
                Stop spraying (setpoint 0)
              </button>

              <button
                onClick={resetSafetyTrip}
                disabled={commandPending}
                className="mt-6 block rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
              >
                Reset Safety Trip
              </button>

              <p className="mt-3 text-xs text-slate-500">
                Reset requires pressure below 40 PSI and battery above 25%.
                Confirm the machine is physically safe before resetting.
              </p>
            </div>

            {commandMessage && (
              <p
                role="status"
                className="mt-5 rounded-lg border border-slate-700 bg-slate-800 p-3 text-sm text-slate-300"
              >
                {commandMessage}
              </p>
            )}
          </section>
        )}

        {/* ALARMS */}
        {activeTab === "Alarms" && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="mb-2 text-xl font-bold">
              Alarms & Conditions
            </h2>

            <p className="mb-6 text-sm text-slate-400">
              Pressure and battery warnings are generated by the backend
              from incoming telemetry. ESP32 alarms are shown separately.
            </p>

            <div className="mb-8">
              <h3 className="mb-4 font-semibold text-slate-200">
                Backend Conditions
              </h3>

              {hmiConditions.length === 0 ? (
                <EmptyMessage message="No active backend conditions." />
              ) : (
                <div className="space-y-3">
                  {hmiConditions.map(condition => (
                    <ConditionCard
                      key={condition.eventId}
                      condition={condition}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="mb-8">
              <h3 className="mb-4 font-semibold text-slate-200">
                ESP32 Alarms & Trips
              </h3>

              {esp32Alarms.length === 0 ? (
                <EmptyMessage message="No ESP32 alarms or trips received." />
              ) : (
                <div className="space-y-3">
                  {esp32Alarms.map((alarm, index) => (
                    <Esp32AlarmCard
                      key={`esp32-alarm-${index}`}
                      alarm={alarm}
                    />
                  ))}
                </div>
              )}
            </div>

            <div>
              <h3 className="mb-4 font-semibold text-slate-200">
                Condition History
              </h3>

              {conditionHistory.length === 0 ? (
                <EmptyMessage message="No condition history available." />
              ) : (
                <div className="space-y-3">
                  {conditionHistory.slice(0, 30).map(condition => (
                    <ConditionHistoryCard
                      key={condition.eventId}
                      condition={condition}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* TRENDS */}
        {activeTab === "Trends" && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-bold">
              Sensor Trends
            </h2>

            <p className="mt-3 text-sm text-slate-400">
              Historical pressure, flow rate and battery charts will be
              added when data storage and history retrieval are implemented.
            </p>
          </section>
        )}

        {/* SETTINGS */}
        {activeTab === "Settings" && (
          <section className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <h2 className="text-xl font-bold">
              Settings & Safety Limits
            </h2>

            <div className="mt-5 space-y-4 text-sm">
              <SettingRow label="Machine ID" value="SPRAYER-001" />
              <SettingRow label="MQTT device ID" value="myplant-7f3k9q" />
              <SettingRow
                label="Backend"
                value={socketConnected ? "Connected" : "Disconnected"}
              />
              <SettingRow label="MQTT" value={mqttStatus} />
              <SettingRow
                label="Sensor data"
                value={
                  dataIsStale
                    ? "Stale"
                    : hasLiveData
                      ? "Current"
                      : "Unavailable"
                }
              />
              <SettingRow label="Telemetry timeout" value="45 seconds" />
              <SettingRow
                label="Pressure warning"
                value="40 PSI"
              />
              <SettingRow
                label="Pressure cutoff"
                value="45 PSI"
              />
              <SettingRow
                label="Battery warning"
                value="25%"
              />
              <SettingRow
                label="Battery cutoff"
                value="20%"
              />
              <SettingRow
                label="Socket error"
                value={socketError || "None"}
              />
            </div>
          </section>
        )}

        {/* POPUP */}
        {popupNotice && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
            <section
              role="alertdialog"
              aria-modal="true"
              className="w-full max-w-md rounded-2xl border border-amber-500/40 bg-slate-900 p-6 shadow-2xl"
            >
              <div className="mb-4 flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/15 text-xl font-bold text-amber-300">
                  !
                </div>

                <div>
                  <h2 className="text-lg font-bold text-amber-200">
                    {popupNotice.title}
                  </h2>

                  <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-slate-300">
                    {popupNotice.message}
                  </p>
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  onClick={() => setPopupNotice(null)}
                  className="rounded-lg bg-amber-400 px-5 py-2.5 font-semibold text-slate-950 hover:bg-amber-300"
                >
                  Acknowledge
                </button>
              </div>
            </section>
          </div>
        )}

        <footer className="mt-8 border-t border-slate-800 pt-5 text-center text-xs text-slate-500">
          Smart Sprayer HMI · Safety monitoring enabled
        </footer>
      </div>
      <style jsx global>{`
        .hmi-theme { min-height: 100vh; background: var(--background); color: var(--foreground); transition: background-color 180ms ease, color 180ms ease; }
        .theme-dark { color-scheme: dark; --background: #020617; --foreground: #f8fafc; }
        .theme-light { color-scheme: light; --background: #f1f5f9; --foreground: #0f172a; }
        .theme-light .bg-slate-950 { background-color: #e2e8f0 !important; }
        .theme-light .bg-slate-900 { background-color: #fff !important; }
        .theme-light .bg-slate-900\/70 { background-color: rgb(255 255 255 / .92) !important; }
        .theme-light .bg-slate-800 { background-color: #f1f5f9 !important; }
        .theme-light .text-white { color: #0f172a !important; }
        .theme-light .text-slate-200 { color: #1e293b !important; }
        .theme-light .text-slate-300 { color: #334155 !important; }
        .theme-light .text-slate-400, .theme-light .text-slate-500 { color: #64748b !important; }
        .theme-light .border-slate-800, .theme-light .border-slate-700 { border-color: #cbd5e1 !important; }
        .theme-light input { color-scheme: light; }
        .theme-light input.bg-slate-950 { background-color: #f8fafc !important; color: #0f172a !important; }
        .theme-light [role=alertdialog] { background-color: #fff !important; color: #0f172a !important; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; } }
      `}</style>
    </main>
  );
}

// =====================================================
// REUSABLE COMPONENTS
// =====================================================

function SensorCard({
  label,
  value,
  unit,
  icon,
  emphasis,
  status,
  warning = false,
  critical = false
}: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  emphasis: "pressure" | "flow";
  status: string;
  warning?: boolean;
  critical?: boolean;
}) {
  const accent = critical
    ? "text-red-400"
    : warning
      ? "text-amber-400"
      : emphasis === "pressure"
        ? "text-emerald-400"
        : "text-sky-400";

  return (
    <div className={`relative overflow-hidden rounded-2xl border bg-slate-900 p-5 shadow-lg sm:p-7 ${critical ? "border-red-500/50" : warning ? "border-amber-500/50" : "border-slate-800"}`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-bold uppercase tracking-[0.16em] text-slate-400 sm:text-base">{label}</p>
        <span className={`text-3xl ${accent}`} aria-hidden="true">{icon}</span>
      </div>

      <div className="mt-5 flex flex-wrap items-baseline gap-2">
        <span className={`text-5xl font-extrabold tracking-tight tabular-nums sm:text-6xl lg:text-7xl ${accent}`}>
          {value}
        </span>
        <span className="text-base font-semibold text-slate-400 sm:text-lg">{unit}</span>
      </div>

      <div className="mt-6 flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${critical ? "bg-red-500" : warning ? "bg-amber-400" : "bg-emerald-400"}`} />
        <span className={`text-xs font-bold tracking-wide ${accent}`}>{status}</span>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-slate-800">
        <div className={`h-full rounded-full ${critical ? "w-full bg-red-500" : warning ? "w-4/5 bg-amber-400" : emphasis === "pressure" ? "w-3/5 bg-emerald-500" : "w-2/3 bg-sky-500"}`} />
      </div>
    </div>
  );
}

function SafetyCard({
  label,
  value,
  active,
  critical
}: {
  label: string;
  value: string;
  active: boolean;
  critical: boolean;
}) {
  const activeStyle = critical
    ? "border-red-500/50 bg-red-500/10 text-red-300"
    : "border-amber-500/50 bg-amber-500/10 text-amber-300";

  return (
    <div
      className={`rounded-xl border p-4 ${
        active
          ? activeStyle
          : "border-slate-800 bg-slate-900 text-slate-300"
      }`}
    >
      <p className="text-xs text-slate-400">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
      <p className="mt-1 text-xs">
        {active ? "ACTIVE" : "Normal"}
      </p>
    </div>
  );
}

function ActionButton({
  label,
  onClick,
  disabled,
  style = "normal"
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  style?: "normal" | "green" | "red";
}) {
  const classes =
    style === "green"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20"
      : style === "red"
        ? "border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20"
        : "border-slate-700 bg-slate-800 text-white hover:border-emerald-500";

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl border p-4 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-50 ${classes}`}
    >
      {label}
    </button>
  );
}

function EmptyMessage({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-4 text-sm text-slate-400">
      {message}
    </div>
  );
}

function ConditionCard({
  condition
}: {
  condition: HmiCondition;
}) {
  const severity = condition.severity?.toUpperCase();
  const isFault = severity === "FAULT";
  const isWarning = severity === "WARNING";

  return (
    <div
      className={`rounded-xl border p-4 ${
        isFault
          ? "border-red-500/30 bg-red-500/10"
          : isWarning
            ? "border-amber-500/30 bg-amber-500/10"
            : "border-slate-700 bg-slate-800"
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{condition.title}</span>

        <span
          className={`text-xs font-bold ${
            isFault
              ? "text-red-300"
              : isWarning
                ? "text-amber-300"
                : "text-slate-300"
          }`}
        >
          {condition.severity}
        </span>
      </div>

      <p className="mt-2 text-sm text-slate-300">
        {condition.message}
      </p>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-400">
        <span>Code: {condition.code}</span>
        <span>Source: {condition.source || "Backend"}</span>
        <span>Status: {condition.status}</span>
        {condition.acknowledgedAt && (
          <span className="text-emerald-300">Acknowledged</span>
        )}
      </div>
    </div>
  );
}

function Esp32AlarmCard({
  alarm
}: {
  alarm: Esp32Alarm;
}) {
  const title =
    alarm.title ??
    alarm.name ??
    alarm.alarm ??
    alarm.code ??
    alarm.type ??
    "ESP32 Machine Event";

  const message =
    alarm.message ??
    alarm.description ??
    alarm.detail ??
    "Event received from the ESP32 controller.";

  const severity =
    alarm.severity ??
    alarm.level ??
    alarm.status ??
    "ESP32 EVENT";

  return (
    <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">{String(title)}</span>
        <span className="text-xs font-bold text-red-300">
          {String(severity)}
        </span>
      </div>

      <p className="mt-2 text-sm text-slate-300">
        {String(message)}
      </p>

      <p className="mt-3 text-xs text-slate-400">
        Source: ESP32 controller
      </p>
    </div>
  );
}

function ConditionHistoryCard({
  condition
}: {
  condition: HmiCondition;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-800 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{condition.title}</span>

        <span
          className={`text-xs font-bold ${
            condition.status === "CLEARED"
              ? "text-emerald-300"
              : "text-amber-300"
          }`}
        >
          {condition.status}
        </span>
      </div>

      <p className="mt-2 text-sm text-slate-400">
        {condition.message}
      </p>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-slate-500">
        <span>Code: {condition.code}</span>
        <span>
          Triggered: {new Date(condition.triggeredAt).toLocaleString()}
        </span>

        {condition.clearedAt && (
          <span>
            Cleared: {new Date(condition.clearedAt).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}

function SettingRow({
  label,
  value
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-800 pb-3">
      <span className="text-slate-400">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  );
}
