import pino from "pino";

const level = process.env.LOG_LEVEL ?? process.env.TIANSHU_LOG_LEVEL ?? "info";

const transport =
  process.env.LOG_FORMAT === "text"
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined;

export const rootLogger = pino({
  level,
  transport,
  timestamp: pino.stdTimeFunctions.isoTime,
  base: undefined,
});

export function createLogger(name: string) {
  return rootLogger.child({ mod: name });
}

/** Adapter: returns a `(msg: string) => void` callback compatible with Connection opts.log */
export function logCallback(name: string): (msg: string) => void {
  const child = createLogger(name);
  return (msg: string) => child.info(msg);
}
