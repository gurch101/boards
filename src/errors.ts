export type ApiStatus = 400 | 401 | 404 | 409 | 412 | 422 | 500;

export class ApiError extends Error {
  constructor(public status: ApiStatus, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export function validationError(message: string) {
  return new ApiError(422, "validation_failed", message);
}
