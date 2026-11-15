// Diagnostics contain fixed field paths/codes only, never values, IDs or transcripts.
export class MetadataValidationError extends Error {
  code: string
  reason: string
  field: string
  constructor(kind: 'DISCUSSION' | 'CONTRIBUTION', reason: string, field: string) {
    super('INVALID_' + kind)
    this.code = 'INVALID_' + kind
    this.reason = reason
    this.field = field
  }
}
export function metadataDiagnostic(error: unknown) {
  return error instanceof MetadataValidationError
    ? { code: error.code, reason: error.reason, field: error.field }
    : { code: 'INVALID_METADATA', reason: 'VALIDATION_FAILED', field: 'metadata' }
}
export function logMetadataDiagnostic(diagnostic: ReturnType<typeof metadataDiagnostic>) {
  console.warn('[Debate metadata] ' + JSON.stringify(diagnostic))
}
