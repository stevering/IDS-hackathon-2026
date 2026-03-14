/**
 * Structured logger for Guardian server-side code.
 *
 * Format: `YYYY-MM-DDTHH:mm:ss.sssZ [tag] level=info k=v k=v | message`
 *
 * Grep-friendly:
 *   grep "u=6285962c"          → all logs for a user
 *   grep "c=kukftiz0"          → all logs for a client
 *   grep "wf=orch-6285"        → all logs for an orchestration
 *   grep "[figma-exec]"        → all figma execution logs
 *   grep "level=error"         → all errors
 */

export type LogContext = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(msg: string, extra?: LogContext): void;
  warn(msg: string, extra?: LogContext): void;
  error(msg: string, extra?: LogContext): void;
  child(ctx: LogContext): Logger;
}

function formatCtx(ctx: LogContext): string {
  return Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function formatLine(
  level: "info" | "warn" | "error",
  tag: string,
  ctx: LogContext,
  msg: string,
  extra?: LogContext,
): string {
  const ts = new Date().toISOString();
  const merged = extra ? { ...ctx, ...extra } : ctx;
  const ctxStr = formatCtx(merged);
  return `${ts} [${tag}] level=${level} ${ctxStr} | ${msg}`;
}

export function createLogger(tag: string, ctx: LogContext = {}): Logger {
  return {
    info(msg: string, extra?: LogContext) {
      console.log(formatLine("info", tag, ctx, msg, extra));
    },
    warn(msg: string, extra?: LogContext) {
      console.warn(formatLine("warn", tag, ctx, msg, extra));
    },
    error(msg: string, extra?: LogContext) {
      console.error(formatLine("error", tag, ctx, msg, extra));
    },
    child(childCtx: LogContext): Logger {
      return createLogger(tag, { ...ctx, ...childCtx });
    },
  };
}
