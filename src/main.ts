import { config } from "./config.js";
import { log } from "./log.js";
import { createApp } from "./server.js";

// Validate config at startup
const warnings = config.validate();
for (const w of warnings) log.warn(`config: ${w}`);

const instance = createApp();

process.on("SIGTERM", () => instance.shutdown().then(() => process.exit(0)));
process.on("SIGINT", () => instance.shutdown().then(() => process.exit(0)));
