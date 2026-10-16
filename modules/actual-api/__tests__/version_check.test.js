const { clientVersion, isClientBehind } = require("../version-check");

describe("isClientBehind compares major.minor only", () => {
    test.each([
        ["26.9.0", "26.10.0", true],
        ["26.10.0", "26.10.0", false],
        ["26.10.0", "26.10.5", false],
        ["26.11.0", "26.10.0", false],
        ["25.12.3", "26.1.0", true],
        ["26.10.0", "26.11.0-nightly.20261012", true],
    ])("client %s vs server %s -> %s", (client, server, expected) => {
        expect(isClientBehind(client, server)).toBe(expected);
    });

    test("clientVersion reads the installed @actual-app/api version", () => {
        expect(clientVersion()).toMatch(/^\d+\.\d+\.\d+/);
    });
});
