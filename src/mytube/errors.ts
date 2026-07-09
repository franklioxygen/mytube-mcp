export type MyTubeErrorCode =
  | "MYTUBE_UNAUTHORIZED"
  | "MYTUBE_FORBIDDEN"
  | "MYTUBE_NOT_FOUND"
  | "MYTUBE_TIMEOUT"
  | "MYTUBE_CONFLICT"
  | "MYTUBE_RATE_LIMITED"
  | "MYTUBE_UNREACHABLE"
  | "MYTUBE_INTERNAL"
  | "MYTUBE_INVALID_PARAMS";

export class MyTubeError extends Error {
  public constructor(
    public readonly code: MyTubeErrorCode,
    message: string,
    public readonly status?: number,
    public readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "MyTubeError";
  }
}

export class MyTubeConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MyTubeConfigurationError";
  }
}

const getBackendMessage = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const record = body as Record<string, unknown>;
  for (const key of ["error", "message"]) {
    if (typeof record[key] === "string" && record[key]) {
      return record[key];
    }
  }
  return undefined;
};

export const mapHttpError = (
  status: number,
  body: unknown,
  _baseUrl: string,
  retryAfterHeader?: string | null,
): MyTubeError => {
  const backendMessage = getBackendMessage(body);
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : undefined;
  switch (status) {
    case 400:
      return new MyTubeError("MYTUBE_INVALID_PARAMS", `Invalid argument: ${backendMessage ?? "request"}`, status);
    case 401:
      return new MyTubeError("MYTUBE_UNAUTHORIZED", "Authentication required or expired", status);
    case 403:
      return new MyTubeError("MYTUBE_FORBIDDEN", "Not permitted in current auth mode", status);
    case 404:
      return new MyTubeError("MYTUBE_NOT_FOUND", "Resource not found", status);
    case 408:
      return new MyTubeError("MYTUBE_TIMEOUT", "MyTube did not respond in time", status);
    case 409:
      return new MyTubeError("MYTUBE_CONFLICT", backendMessage ?? "MyTube rejected the conflicting operation", status);
    case 429:
      return new MyTubeError(
        "MYTUBE_RATE_LIMITED",
        `Rate limited; retry after ${Number.isFinite(retryAfterSeconds) ? `${retryAfterSeconds} s` : "a short delay"}`,
        status,
        Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
      );
    default:
      if (status >= 500) {
        return new MyTubeError("MYTUBE_INTERNAL", "MyTube returned an internal error", status);
      }
      return new MyTubeError("MYTUBE_INTERNAL", `MyTube request failed (${status})`, status);
  }
};

export const mapNetworkError = (error: unknown, baseUrl: string): MyTubeError => {
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return new MyTubeError("MYTUBE_TIMEOUT", "MyTube did not respond in time");
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new MyTubeError("MYTUBE_TIMEOUT", "MyTube request was cancelled");
  }
  return new MyTubeError("MYTUBE_UNREACHABLE", `Cannot reach MyTube at ${baseUrl}`);
};
