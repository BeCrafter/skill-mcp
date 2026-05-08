import pino from "pino";

let _logger: pino.Logger | null = null;

export function createLogger(level?: string): pino.Logger {
  const isProduction = process.env.NODE_ENV === "production";
  // Always write logs to stderr — stdout is reserved for JSON-RPC in stdio transport mode.
  return pino(
    {
      level: level ?? process.env.LOG_LEVEL ?? "info",
      ...(isProduction
        ? {}
        : {
            transport: {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:yyyy-mm-dd HH:MM:ss", destination: 2 },
            },
          }),
    },
    isProduction ? pino.destination(2) : undefined,
  );
}

export function getLogger(): pino.Logger {
  if (!_logger) {
    _logger = createLogger();
  }
  return _logger;
}

export function setLogger(logger: pino.Logger): void {
  _logger = logger;
}
