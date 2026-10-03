import {Zcl} from "zigbee-herdsman";
import * as fz from "../converters/fromZigbee";
import * as tz from "../converters/toZigbee";
import * as exposes from "../lib/exposes";
import * as m from "../lib/modernExtend";
import * as reporting from "../lib/reporting";
import type {DefinitionWithExtend, Fz, KeyValue, Tz, Zh} from "../lib/types";
import * as utils from "../lib/utils";

interface IntuisSpecific {
    attributes: never;
    commands: never;
    commandResponses: {
        data: {data: Buffer};
        acknowledgement: {data: Buffer};
    };
}

const fzLocal = {
    acknowledgement: {
        cluster: "intuisSpecific",
        type: "commandAcknowledgement",
        convert: () => {},
    } satisfies Fz.Converter<"intuisSpecific", IntuisSpecific, "commandAcknowledgement">,
    status: {
        cluster: "intuisSpecific",
        type: "commandData",
        convert: (model, msg, publish, options, meta) => {
            const data = msg.data.data;
            if (data.length !== 48 || data.readUInt32BE(0) !== 1) return;

            const result: KeyValue = {};

            if (
                data.subarray(12, 16).equals(Buffer.from([0xff, 0x1a, 0x20, 0xff])) &&
                (data[16] === 0x43 || data[16] === 0x73) &&
                (data[17] === 0x01 || data[17] === 0x08 || data[17] === 0x09) &&
                data[18] === 0x00
            ) {
                // Captured off/heat status flags, including updates from the radiator's physical controls.
                const systemMode = data[16] === 0x43 ? 0 : 4;
                // Manual Comfort uses the standard setpoint; the captured external override uses property 0x12.
                if (meta.device.meta.intuisSetpointControl !== data[17] || meta.device.meta.intuisSystemMode !== systemMode) {
                    meta.device.meta.intuisSetpointControl = data[17];
                    meta.device.meta.intuisSystemMode = systemMode;
                    meta.device.save();
                }
                result[utils.postfixWithEndpointName("system_mode", msg, model, meta)] = systemMode === 0 ? "off" : "heat";
                result[utils.postfixWithEndpointName("current_heating_setpoint", msg, model, meta)] = (data[19] + 70) / 10;
            }
            if (data.subarray(12, 18).equals(Buffer.from([0xff, 0x1e, 0x20, 0xff, 0x02, 0x04]))) {
                result.keypad_lockout = data[18] === 0 ? "unlock" : "lock1";
            }
            if (data.subarray(12, 18).equals(Buffer.from([0xff, 0x1e, 0x20, 0xff, 0x02, 0x14]))) {
                const temperatureDisplayMode = data[18] === 0x69 ? "celsius" : data[18] === 0x6d ? "fahrenheit" : undefined;
                if (temperatureDisplayMode !== undefined) result.temperature_display_mode = temperatureDisplayMode;
            }
            if (data.subarray(12, 18).equals(Buffer.from([0xff, 0x1e, 0x20, 0x00, 0x02, 0x19]))) {
                result[utils.postfixWithEndpointName("local_temperature", msg, model, meta)] = data.readUInt16BE(19) / 10;
            }
            if (data.subarray(12, 17).equals(Buffer.from([0xdf, 0x1d, 0x20, 0x00, 0x3f]))) {
                result[utils.postfixWithEndpointName("energy", msg, model, meta)] = data.readUInt16LE(17);
            }
            if (data.subarray(12, 17).equals(Buffer.from([0xff, 0x42, 0x20, 0x00, 0x00]))) {
                result[utils.postfixWithEndpointName("rated_power", msg, model, meta)] = data.readUInt16LE(17);
            }

            return Object.keys(result).length > 0 ? result : undefined;
        },
    } satisfies Fz.Converter<"intuisSpecific", IntuisSpecific, "commandData">,
    thermostat: {
        cluster: "hvacThermostat",
        type: ["attributeReport", "readResponse"],
        convert: (model, msg, publish, options, meta) => {
            const occupiedHeatingSetpoint = msg.data.occupiedHeatingSetpoint;
            const result: KeyValue = {};
            if (occupiedHeatingSetpoint !== undefined) {
                result[utils.postfixWithEndpointName("current_heating_setpoint", msg, model, meta)] = occupiedHeatingSetpoint / 100;
            }
            // This register can stay at heat after physical off. Prefer a known native status over its cached value.
            if (meta.device.meta.intuisSystemMode === undefined && (msg.data.systemMode === 0 || msg.data.systemMode === 4)) {
                result[utils.postfixWithEndpointName("system_mode", msg, model, meta)] = msg.data.systemMode === 0 ? "off" : "heat";
            }
            return Object.keys(result).length > 0 ? result : undefined;
        },
    } satisfies Fz.Converter<"hvacThermostat", undefined, ["attributeReport", "readResponse"]>,
};

const commandQueues = new Map<string, Promise<void>>();

async function sendIntuisData(entity: Zh.Endpoint, operation: number, body: number[], protocolLength: number) {
    const device = entity.getDevice();
    const previous = commandQueues.get(device.ieeeAddr) ?? Promise.resolve();
    // Serialize sequence allocation and transmission; a failed write must not block later commands.
    const pending = previous
        .catch(() => {})
        .then(async () => {
            const data = Buffer.alloc(48);
            const commandSequence = (((device.meta.intuisCommandSequence as number | undefined) ?? 0x5f) + 1) & 0xff;
            device.meta.intuisCommandSequence = commandSequence;
            device.save();
            data.writeUInt32BE(operation, 0);
            data.writeUInt32LE(commandSequence, 4);
            data.writeUInt32LE(Math.floor(process.uptime()), 8);
            Buffer.from(body).copy(data, 12);
            // Captured protocol lengths include padding and are not the number of supplied body bytes.
            data[39] = protocolLength;
            Buffer.from(device.ieeeAddr.slice(2), "hex").reverse().copy(data, 40);

            const options = {disableDefaultResponse: true, apsEncryption: true};
            await entity.commandResponse<"intuisSpecific", "data", IntuisSpecific>("intuisSpecific", "data", {data}, options, 0);
        });
    commandQueues.set(device.ieeeAddr, pending);
    try {
        await pending;
    } finally {
        if (commandQueues.get(device.ieeeAddr) === pending) {
            commandQueues.delete(device.ieeeAddr);
        }
    }
}

const tzLocal = {
    ratedPower: {
        key: ["rated_power"],
        convertGet: async (entity) => {
            utils.assertEndpoint(entity);
            await requestIntuisRatedPower(entity);
        },
    } satisfies Tz.Converter,
    setpoint: {
        key: ["current_heating_setpoint"],
        convertSet: async (entity, key, value, meta) => {
            utils.assertNumber(value, key);
            if (value < 7 || value > 28 || !Number.isInteger(value * 2)) {
                throw new Error(`${key} must be between 7 and 28 in steps of 0.5`);
            }

            utils.assertEndpoint(entity);
            const device = entity.getDevice();
            if (device.meta.intuisSetpointControl === 0x08) {
                await sendIntuisData(entity, 2, [0xe0, 0x1e, 0x00, 0x2f, 0x02, 0x12, value * 10 - 70], 11);
            } else {
                await entity.write("hvacThermostat", {occupiedHeatingSetpoint: value * 100});
            }

            return {state: {current_heating_setpoint: value}};
        },
    } satisfies Tz.Converter,
    windowDetection: {
        key: ["window_detection"],
        convertSet: async (entity, key, value, meta) => {
            if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
            utils.assertEndpoint(entity);
            await sendIntuisData(entity, 0, [0xe0, 0x1e, 0x00, 0xff, 0x02, 0x02, value ? 1 : 0], 11);
            return {state: {window_detection: value}};
        },
    } satisfies Tz.Converter,
    temperatureDisplayMode: {
        key: ["temperature_display_mode"],
        convertSet: async (entity, key, value, meta) => {
            utils.assertString(value, key);
            if (value !== "celsius" && value !== "fahrenheit") throw new Error(`${key} must be celsius or fahrenheit`);
            utils.assertEndpoint(entity);
            const unit = value === "celsius" ? 0x69 : 0x6d;
            const checksum = value === "celsius" ? 0x44 : 0x40;
            await sendIntuisData(entity, 2, [0xe0, 0x1e, 0x00, 0xff, 0x02, 0x14, unit, 0x00, 0x00, 0x00, checksum], 12);
            return {state: {temperature_display_mode: value}};
        },
        convertGet: async (entity) => {
            await entity.read("hvacUserInterfaceCfg", ["tempDisplayMode"]);
        },
    } satisfies Tz.Converter,
};

async function requestIntuisStatus(entity: Zh.Endpoint) {
    const ieee = Buffer.from(entity.getDevice().ieeeAddr.slice(2), "hex").reverse();
    // Reply to the captured module-identity request; this elicits status without writing targets or profiles.
    await sendIntuisData(entity, 1, [0x40, 0x3f, 0x00, 0x20, ...ieee.subarray(0, 4)], 8);
}

async function requestIntuisRatedPower(entity: Zh.Endpoint) {
    // Captured read request for property 0x42; the response contains the configured wattage.
    await sendIntuisData(entity, 0, [0xa0, 0x42, 0x00, 0x20, 0x00], 7);
}

export const definitions: DefinitionWithExtend[] = [
    {
        zigbeeModel: ["intuisradiator                 "],
        model: "intuisradiator",
        vendor: "Intuis",
        description: "Radiator with nativ and intuis 3.0",
        extend: [
            m.deviceEndpoints({endpoints: {1: 1, 5: 5}}),
            m.electricityMeter({
                cluster: "metering",
                power: false,
                status: true,
                endpointNames: ["1"],
            }),
            m.occupancy({endpointNames: ["1"]}),
        ],
        fromZigbee: [fz.thermostat, fz.hvac_user_interface],
        toZigbee: [
            tz.thermostat_local_temperature,
            tz.thermostat_occupied_heating_setpoint,
            tz.thermostat_unoccupied_heating_setpoint,
            tz.thermostat_running_state,
            tz.thermostat_system_mode,
            tz.thermostat_temperature_display_mode,
            tz.thermostat_keypad_lockout,
        ],
        exposes: [
            exposes.presets
                .climate()
                .withLocalTemperature()
                .withSetpoint("occupied_heating_setpoint", 7, 28, 0.5)
                .withSetpoint("unoccupied_heating_setpoint", 7, 28, 0.5)
                .withRunningState(["idle", "heat"])
                .withSystemMode(["off", "heat"])
                .withEndpoint("1"),
            exposes.presets.keypad_lockout(),
            new exposes.Enum("temperature_display_mode", exposes.access.ALL, ["celsius", "fahrenheit"]).withDescription(
                "Controls the temperature unit of the thermostat display.",
            ),
        ],
        configure: async (device, coordinatorEndpoint, definition) => {
            const endpoint = device.getEndpoint(1);

            await reporting.bind(endpoint, coordinatorEndpoint, ["hvacThermostat", "hvacUserInterfaceCfg"]);
            await reporting.thermostatTemperature(endpoint);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatRunningState(endpoint);
            await reporting.thermostatSystemMode(endpoint);

            // These are not reportable so we poll them once
            await endpoint.read("hvacThermostat", ["unoccupiedHeatingSetpoint"]);
            await endpoint.read("hvacUserInterfaceCfg", ["tempDisplayMode"]);
            await endpoint.read("hvacUserInterfaceCfg", ["keypadLockout"]);
        },
        meta: {multiEndpoint: true},
    },
    {
        fingerprint: [{modelID: "intuisradiator                 ", manufacturerID: Zcl.ManufacturerCode.GROUPE_MULLER}],
        model: "intuisradiator-intuis3",
        vendor: "Intuis",
        description: "Electric radiator (manufacturer 0x122e)",
        extend: [
            m.deviceEndpoints({endpoints: {1: 1, 5: 5}}),
            m.deviceAddCustomCluster("intuisSpecific", {
                name: "intuisSpecific",
                ID: 0xfd01,
                manufacturerCode: Zcl.ManufacturerCode.GROUPE_MULLER,
                attributes: {},
                commands: {},
                commandsResponse: {
                    data: {name: "data", ID: 0x00, parameters: [{name: "data", type: Zcl.BuffaloZclDataType.BUFFER}]},
                    acknowledgement: {name: "acknowledgement", ID: 0x01, parameters: [{name: "data", type: Zcl.BuffaloZclDataType.BUFFER}]},
                },
            }),
            {
                isModernExtend: true,
                onEvent: [
                    async (event) => {
                        // Configuration is cached across restarts. Elicit telemetry again after startup/reconnection.
                        if (event.type === "start" || event.type === "deviceAnnounce") {
                            const endpoint = event.data.device.getEndpoint(1);
                            await requestIntuisStatus(endpoint);
                            await requestIntuisRatedPower(endpoint);
                            await endpoint.read("hvacThermostat", ["systemMode"]);
                        }
                    },
                ],
            },
        ],
        fromZigbee: [fzLocal.thermostat, fz.hvac_user_interface, fzLocal.acknowledgement, fzLocal.status],
        toZigbee: [
            tzLocal.setpoint,
            tzLocal.windowDetection,
            tzLocal.temperatureDisplayMode,
            tzLocal.ratedPower,
            tz.thermostat_system_mode,
            tz.thermostat_keypad_lockout,
        ],
        exposes: [
            exposes.presets
                .climate()
                .withLocalTemperature(exposes.access.STATE)
                .withSetpoint("current_heating_setpoint", 7, 28, 0.5, exposes.access.STATE_SET)
                .withSystemMode(["off", "heat"])
                .withLabel("Target setpoint")
                .withHomeAssistant({name: "Target setpoint"})
                .withEndpoint("1"),
            exposes.presets.keypad_lockout(),
            exposes.presets.window_detection_bool(exposes.access.STATE_SET),
            new exposes.Enum("temperature_display_mode", exposes.access.ALL, ["celsius", "fahrenheit"]).withDescription(
                "Controls the temperature unit of the thermostat display.",
            ),
            new exposes.Numeric("rated_power", exposes.access.STATE_GET).withUnit("W").withDescription("Configured radiator power").withEndpoint("1"),
            new exposes.Numeric("energy", exposes.access.STATE)
                .withUnit("Wh")
                .withDescription("Energy consumed during the latest reporting interval, not cumulative")
                .withCategory("diagnostic")
                .withEndpoint("1"),
        ],
        configure: async (device, coordinatorEndpoint) => {
            const endpoint = device.getEndpoint(1);

            await reporting.bind(endpoint, coordinatorEndpoint, ["hvacThermostat", "hvacUserInterfaceCfg"]);
            await reporting.thermostatOccupiedHeatingSetpoint(endpoint);
            await reporting.thermostatSystemMode(endpoint);

            await endpoint.read("hvacThermostat", ["occupiedHeatingSetpoint", "systemMode"]);
            await endpoint.read("hvacUserInterfaceCfg", ["tempDisplayMode"]);
            await endpoint.read("hvacUserInterfaceCfg", ["keypadLockout"]);
            await requestIntuisStatus(endpoint);
            await requestIntuisRatedPower(endpoint);
        },
        meta: {
            multiEndpoint: true,
            overrideHaDiscoveryPayload: (payload) => {
                // Interval consumption is not a cumulative meter, despite HA discovery's default for Wh sensors.
                if (payload.device_class === "energy") delete payload.state_class;
            },
        },
    },
];
