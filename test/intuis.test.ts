import {describe, expect, it, vi} from "vitest";
import {definitions} from "../src/devices/intuis";
import {findByDevice, prepareDefinition} from "../src/index";
import type {Tz} from "../src/lib/types";
import {mockDevice} from "./utils";

const intuisDefinition = definitions.find((item) => item.model === "intuisradiator-intuis3");
if (!intuisDefinition) throw new Error("Intuis definition not found");
const definition = prepareDefinition(intuisDefinition);

function statusData(body: number[]) {
    const data = Buffer.alloc(48);
    data.writeUInt32BE(1, 0);
    Buffer.from(body).copy(data, 12);
    return data;
}

function convertStatus(
    data: Buffer,
    device = mockDevice({modelID: "intuisradiator                 ", manufacturerID: 0x122e, endpoints: [{ID: 1}]}),
) {
    if (!vi.isMockFunction(device.save)) vi.spyOn(device, "save").mockImplementation(() => {});
    const converter = definition.fromZigbee.find((item) => item.cluster === "intuisSpecific" && item.type === "commandData");
    if (!converter) throw new Error("Intuis status converter not found");

    return converter.convert(
        definition,
        {data: {data}, endpoint: device.getEndpoint(1), type: "commandData", cluster: "intuisSpecific"} as Parameters<typeof converter.convert>[1],
        vi.fn(),
        {},
        {device, state: {}, deviceExposesChanged: vi.fn()},
    );
}

function createWriter() {
    const device = mockDevice({
        modelID: "intuisradiator                 ",
        manufacturerID: 0x122e,
        ieeeAddr: "0x00124b0000000001",
        endpoints: [{ID: 1}],
    });
    const endpoint = device.getEndpoint(1);
    device.meta.intuisSetpointControl = 0x08;
    const commandResponse = vi.spyOn(endpoint, "commandResponse").mockResolvedValue(undefined);
    const write = vi.mocked(endpoint.write);
    const save = vi.spyOn(device, "save").mockImplementation(() => {});
    const meta: Tz.Meta = {
        device,
        mapped: definition,
        state: {},
        message: {},
        options: {},
        endpoint_name: "1",
        publish: vi.fn(),
        deviceExposesChanged: vi.fn(),
    };
    const set = async (key: string, value: unknown) => {
        const converter = definition.toZigbee.find((item) => item.key.includes(key));
        if (!converter?.convertSet) throw new Error(`Intuis writer not found for ${key}`);
        return await converter.convertSet(endpoint, key, value, meta);
    };
    return {device, endpoint, commandResponse, write, save, set};
}

describe("Intuis radiator protocol", () => {
    it("selects the custom definition only for the matching manufacturer", async () => {
        const matchingDevice = mockDevice({modelID: "intuisradiator                 ", manufacturerID: 0x122e, endpoints: [{ID: 1}]});
        const fallbackDevice = mockDevice({modelID: "intuisradiator                 ", manufacturerID: 0x1234, endpoints: [{ID: 1}]});
        const unknownManufacturerDevice = mockDevice({modelID: "intuisradiator                 ", manufacturerID: undefined, endpoints: [{ID: 1}]});

        expect((await findByDevice(matchingDevice))?.model).toBe("intuisradiator-intuis3");
        expect((await findByDevice(fallbackDevice))?.model).toBe("intuisradiator");
        expect((await findByDevice(unknownManufacturerDevice))?.model).toBe("intuisradiator");
    });

    it("exposes local temperature as reporting-only", () => {
        const climate = definition.exposes.find((expose) => expose.type === "climate");
        const localTemperature = climate?.features.find((feature) => feature.name === "local_temperature");

        expect(localTemperature?.access).toBe(1);
        expect(definition.toZigbee.flatMap((converter) => converter.key)).not.toContain("local_temperature");
    });

    it("exposes interval energy with the canonical name and Wh unit", () => {
        const energy = definition.exposes.find((expose) => expose.name === "energy");

        expect(energy).toMatchObject({name: "energy", property: "energy_1", label: "Energy", unit: "Wh", endpoint: "1"});
        expect(energy?.description).toContain("latest reporting interval");
        expect(energy?.description).toContain("not cumulative");
    });

    it("removes cumulative energy statistics without changing units or other entities", () => {
        const energy = {device_class: "energy", unit_of_measurement: "Wh", state_class: "total_increasing"};
        const temperature = {device_class: "temperature", state_class: "measurement"};
        definition.meta.overrideHaDiscoveryPayload(energy);
        definition.meta.overrideHaDiscoveryPayload(temperature);
        expect(energy).toStrictEqual({device_class: "energy", unit_of_measurement: "Wh"});
        expect(temperature.state_class).toBe("measurement");
        expect(definitions[0].meta.overrideHaDiscoveryPayload).toBeUndefined();
    });

    it("ignores incomplete frames, unrelated operations and unknown properties", () => {
        for (const length of [0, 3, 47, 49]) expect(convertStatus(Buffer.alloc(length))).toBeUndefined();
        const request = statusData([0xff, 0x1a, 0x20, 0xff, 0x73, 0x08, 0x00, 120]);
        request.writeUInt32BE(2, 0);
        expect(convertStatus(request)).toBeUndefined();
        expect(convertStatus(statusData([0xff, 0xff]))).toBeUndefined();
    });

    it.each([
        [0x69, "celsius"],
        [0x6d, "fahrenheit"],
        [0xff, undefined],
    ] as const)("decodes display mode %s", (unit, mode) => {
        expect(convertStatus(statusData([0xff, 0x1e, 0x20, 0xff, 0x02, 0x14, unit]))).toEqual(
            mode === undefined ? undefined : {temperature_display_mode: mode},
        );
    });

    it("decodes the documented 48-byte status fields with their protocol byte order", () => {
        expect(convertStatus(statusData([0xff, 0x1a, 0x20, 0xff, 0x73, 0x08, 0x00, 0xd7]))).toStrictEqual({
            current_heating_setpoint_1: 28.5,
            system_mode_1: "heat",
        });

        const temperature = statusData([0xff, 0x1e, 0x20, 0x00, 0x02, 0x19]);
        temperature.writeUInt16BE(215, 19);
        expect(convertStatus(temperature)).toStrictEqual({local_temperature_1: 21.5});

        const energy = statusData([0xdf, 0x1d, 0x20, 0x00, 0x3f]);
        energy.writeUInt16LE(0x1234, 17);
        expect(convertStatus(energy)).toStrictEqual({energy_1: 0x1234});

        const ratedPower = statusData([0xff, 0x42, 0x20, 0x00, 0x00]);
        ratedPower.writeUInt16LE(0x3412, 17);
        expect(convertStatus(ratedPower)).toStrictEqual({rated_power_1: 0x3412});
    });

    it("encodes a target setpoint using C*10-70 in a padded 48-byte request", async () => {
        const {commandResponse, set, save} = createWriter();
        expect(await set("current_heating_setpoint", 25)).toEqual({state: {current_heating_setpoint: 25}});

        const request = commandResponse.mock.calls[0][2] as {data: Buffer};
        expect(request.data.length).toBe(48);
        expect(request.data.readUInt32BE(0)).toBe(2);
        expect(request.data.subarray(12, 19)).toStrictEqual(Buffer.from([0xe0, 0x1e, 0x00, 0x2f, 0x02, 0x12, 0xb4]));
        expect(request.data[39]).toBe(11);
        expect(request.data.subarray(40)).toStrictEqual(Buffer.from("01000000004b1200", "hex"));
        expect(request.data.readUInt32LE(4)).toBe(0x60);
        expect(save).toHaveBeenCalledOnce();
        expect(commandResponse).toHaveBeenCalledWith("intuisSpecific", "data", request, {disableDefaultResponse: true, apsEncryption: true}, 0);
    });

    it("uses the standard setpoint in the observed manual Comfort state", async () => {
        const {device, set, write, commandResponse} = createWriter();
        expect(convertStatus(statusData([0xff, 0x1a, 0x20, 0xff, 0x73, 0x01, 0x00, 120]), device)).toEqual({
            current_heating_setpoint_1: 19,
            system_mode_1: "heat",
        });
        expect(device.meta.intuisSetpointControl).toBe(0x01);
        await expect(set("current_heating_setpoint", 20)).resolves.toEqual({state: {current_heating_setpoint: 20}});
        expect(write).toHaveBeenCalledWith("hvacThermostat", {occupiedHeatingSetpoint: 2000});
        expect(commandResponse).not.toHaveBeenCalled();

        // Physical off reports the same target with different native status/control flags.
        expect(convertStatus(statusData([0xff, 0x1a, 0x20, 0xff, 0x43, 0x09, 0x00, 120]), device)).toEqual({
            current_heating_setpoint_1: 19,
            system_mode_1: "off",
        });
        expect(device.meta.intuisSystemMode).toBe(0);
        const thermostat = definition.fromZigbee.find((converter) => converter.cluster === "hvacThermostat");
        const staleRead = thermostat.convert(
            definition,
            {data: {systemMode: 4}, endpoint: device.getEndpoint(1), type: "readResponse", cluster: "hvacThermostat"},
            vi.fn(),
            {},
            {device, state: {}, deviceExposesChanged: vi.fn()},
        );
        expect(staleRead).toBeUndefined();
    });

    it("uses the standard write when no control-state report has arrived", async () => {
        const {device, set, write, commandResponse} = createWriter();
        delete device.meta.intuisSetpointControl;
        await set("current_heating_setpoint", 20);
        expect(commandResponse).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledWith("hvacThermostat", {occupiedHeatingSetpoint: 2000});
    });

    it("configures the captured identity exchange and rated-power query without replaying synchronization writes", async () => {
        const {device, endpoint, commandResponse, write} = createWriter();
        await definition.configure(device, endpoint, definition);
        expect(write).not.toHaveBeenCalled();
        expect(commandResponse).toHaveBeenCalledTimes(2);
        const {data} = commandResponse.mock.calls[0][2] as {data: Buffer};
        expect(data.readUInt32BE(0)).toBe(1);
        expect(data.subarray(12, 20)).toEqual(Buffer.from([0x40, 0x3f, 0x00, 0x20, 0x01, 0x00, 0x00, 0x00]));
        expect(data[39]).toBe(8);
        const ratedPower = (commandResponse.mock.calls[1][2] as {data: Buffer}).data;
        expect(ratedPower.readUInt32BE(0)).toBe(0);
        expect(ratedPower.subarray(12, 17)).toEqual(Buffer.from([0xa0, 0x42, 0x00, 0x20, 0x00]));
        expect(ratedPower[39]).toBe(7);
    });

    it("retains the captured override write when the report selects external override control", async () => {
        const {device, set, write, commandResponse} = createWriter();
        device.meta.intuisSetpointControl = 0x01;
        convertStatus(statusData([0xff, 0x1a, 0x20, 0xff, 0x73, 0x08, 0x00, 120]), device);
        await set("current_heating_setpoint", 20);
        expect(write).not.toHaveBeenCalled();
        expect(commandResponse).toHaveBeenCalledOnce();
        const {data} = commandResponse.mock.calls[0][2] as {data: Buffer};
        expect(data.subarray(12, 19)).toEqual(Buffer.from([0xe0, 0x1e, 0x00, 0x2f, 0x02, 0x12, 130]));
    });

    it.each([6.5, 28.5, 19.25, Number.NaN, Number.POSITIVE_INFINITY, "19", null])("rejects invalid target %s before sending", async (value) => {
        const {set, commandResponse, save} = createWriter();
        await expect(set("current_heating_setpoint", value)).rejects.toThrow();
        expect(commandResponse).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it.each([7, 19.5, 28])("encodes valid target %s exactly", async (value) => {
        const {set, commandResponse} = createWriter();
        expect(await set("current_heating_setpoint", value)).toEqual({state: {current_heating_setpoint: value}});
        const {data} = commandResponse.mock.calls[0][2] as {data: Buffer};
        expect((data[18] + 70) / 10).toBe(value);
    });

    it.each([
        {key: "window_detection", value: true, operation: 0, body: [0xe0, 0x1e, 0, 0xff, 2, 2, 1], length: 11},
        {key: "window_detection", value: false, operation: 0, body: [0xe0, 0x1e, 0, 0xff, 2, 2, 0], length: 11},
        {key: "temperature_display_mode", value: "celsius", operation: 2, body: [0xe0, 0x1e, 0, 0xff, 2, 0x14, 0x69, 0, 0, 0, 0x44], length: 12},
        {key: "temperature_display_mode", value: "fahrenheit", operation: 2, body: [0xe0, 0x1e, 0, 0xff, 2, 0x14, 0x6d, 0, 0, 0, 0x40], length: 12},
    ])("encodes $key=$value", async ({key, value, operation, body, length}) => {
        const {set, commandResponse} = createWriter();
        expect(await set(key, value)).toEqual({state: {[key]: value}});
        const {data} = commandResponse.mock.calls[0][2] as {data: Buffer};
        expect(data.readUInt32BE(0)).toBe(operation);
        expect(data.subarray(12, 12 + body.length)).toEqual(Buffer.from(body));
        expect(data[39]).toBe(length);
        expect(commandResponse.mock.calls[0][3]).toEqual({disableDefaultResponse: true, apsEncryption: true});
    });

    it("serializes writes, preserves sequence wrap and recovers after a failed command", async () => {
        const {device, set, commandResponse} = createWriter();
        device.meta.intuisCommandSequence = 0xfe;
        let rejectFirst!: (error: Error) => void;
        commandResponse.mockImplementationOnce(
            () =>
                new Promise((resolve, reject) => {
                    rejectFirst = reject;
                }),
        );
        const first = set("current_heating_setpoint", 19);
        const failed = expect(first).rejects.toThrow("send failed");
        const second = set("window_detection", true);
        await vi.waitFor(() => expect(commandResponse).toHaveBeenCalledTimes(1));
        rejectFirst(new Error("send failed"));
        await failed;
        await expect(second).resolves.toEqual({state: {window_detection: true}});
        await set("temperature_display_mode", "celsius");
        expect(commandResponse.mock.calls.map((call) => (call[2] as {data: Buffer}).data.readUInt32LE(4))).toEqual([0xff, 0, 1]);
    });
});
