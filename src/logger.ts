// Small console logging helper: a symbol + color per level, plus a subsystem tag
// (e.g. "LLM", "Tool", "KB"), so terminal output is easy to scan at a glance.
// No external dependency — just raw ANSI escape codes, skipped when stdout isn't a TTY.

const colorEnabled = process.stdout.isTTY ?? false;

const codes = {
    reset: "\x1b[0m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    magenta: "\x1b[35m",
};

function paint(code: string, text: string): string {
    return colorEnabled ? `${code}${text}${codes.reset}` : text;
}

function tag(name: string): string {
    return paint(codes.dim, `[${name}]`);
}

export const log = {
    /** Neutral progress info, e.g. "reading document: ...". */
    info: (subsystem: string, message: string) => console.log(paint(codes.cyan, "ℹ"), tag(subsystem), message),
    /** Something completed successfully. */
    success: (subsystem: string, message: string) => console.log(paint(codes.green, "✓"), tag(subsystem), message),
    /** A step in an ongoing operation, e.g. a tool call being executed. */
    step: (subsystem: string, message: string) => console.log(paint(codes.magenta, "→"), tag(subsystem), message),
    /** Recoverable problem, e.g. a retried request. */
    warn: (subsystem: string, message: string, err?: unknown) => console.warn(paint(codes.yellow, "⚠"), tag(subsystem), message, err ?? ""),
    /** Unrecoverable problem. */
    error: (subsystem: string, message: string, err?: unknown) => console.error(paint(codes.red, "✖"), tag(subsystem), message, err ?? ""),
    /** Pretty-printed, dimmed JSON payload — for logging a value rather than a message. */
    json: (value: unknown) => console.log(paint(codes.dim, JSON.stringify(value, null, 2))),
};
