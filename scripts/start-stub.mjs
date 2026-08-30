process.env.GATEWAY_CONFIG_PATH = "./src/config/config.stub.yaml";
await import("../dist/mcp/server.js");
