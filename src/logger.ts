type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(level: LogLevel) {
  const threshold = LEVELS[level];
  return {
    debug: (...args: any[]) => { if (LEVELS.debug >= threshold) console.log("[Auto-Reviewer]", ...args); },
    info: (...args: any[]) => { if (LEVELS.info >= threshold) console.log("[Auto-Reviewer]", ...args); },
    warn: (...args: any[]) => { if (LEVELS.warn >= threshold) console.warn("[Auto-Reviewer]", ...args); },
    error: (...args: any[]) => { if (LEVELS.error >= threshold) console.error("[Auto-Reviewer]", ...args); },
  };
}

export type Logger = ReturnType<typeof createLogger>;
