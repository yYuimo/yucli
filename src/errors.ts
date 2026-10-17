export class ConfigError extends Error {
  override name = "ConfigError";
}

export type RequestErrorCode = "network" | "timeout" | "http";

export class RequestError extends Error {
  override name = "RequestError";

  constructor(
    public readonly code: RequestErrorCode,
    message: string,
    public readonly status?: number,
    public readonly responseSummary?: string,
  ) {
    super(message);
  }
}

export class ResponseError extends Error {
  override name = "ResponseError";
}

export class AbortError extends Error {
  override name = "AbortError";
}
