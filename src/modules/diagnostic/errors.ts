export type DiagnosticErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'NO_CONFIRMED_QUERIES'
  | 'PLATFORM_NOT_CONFIGURED'
  | 'RUN_SCOPE_TOO_LARGE'
  | 'RUN_NOT_EDITABLE'
  | 'RUN_NOT_STARTABLE'
  | 'QUEUE_UNAVAILABLE'
  | 'NO_VALID_SAMPLES'
  | 'REPORT_NOT_READY'
  | 'ACTION_NOT_CONVERTIBLE'
  | 'ALREADY_CONVERTED'

export class DiagnosticError extends Error {
  constructor(public readonly code: DiagnosticErrorCode, message: string) {
    super(message)
    this.name = 'DiagnosticError'
  }
}
