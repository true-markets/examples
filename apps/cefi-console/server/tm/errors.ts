// An error from a True Markets API, with the status kept so routes can pass it on.
export class TmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }

  // Error bodies come as { error: { title, detail } } on CeFi REST, and { code, message } on Gateway.
  static async from(res: Response, doing: string): Promise<TmError> {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try {
      const body = JSON.parse(text) as Record<string, unknown>;
      const inner = (typeof body.error === "object" && body.error ? body.error : body) as Record<string, unknown>;
      const parts = [inner.detail, inner.message, inner.title, inner.code, typeof body.error === "string" ? body.error : undefined]
        .filter((v): v is string => typeof v === "string" && v.length > 0);
      if (parts.length) detail = [...new Set(parts)].join(": ");
    } catch {
      // not JSON; keep the text
    }
    return new TmError(`${doing} failed (${res.status})${detail ? `: ${detail}` : ""}`, res.status);
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
