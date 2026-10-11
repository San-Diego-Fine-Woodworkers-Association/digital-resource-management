// The audit trail: one structured JSON line per upload event, written to
// stdout so it lands in the container log. Only the fields listed here are
// ever written, so file contents, cookies and keys cannot leak into it.

export interface AuditEvent {
  event: "upload_request";
  outcome: string;
  method?: string;
  path?: string;
  /** Who, from the verified session (never from the browser). */
  user?: { id: string; email: string; memberId: string | null };
  submissionId?: string;
  uploadId?: string;
  sizeBytes?: number;
  detectedType?: string;
  ip?: string;
}

export type AuditSink = (line: string) => void;

export interface AuditLog {
  record: (event: AuditEvent) => void;
}

export const stdoutSink: AuditSink = (line) => {
  process.stdout.write(line + "\n");
};

export function createAuditLog(sink: AuditSink, now: () => Date = () => new Date()): AuditLog {
  return {
    record(e) {
      const line = {
        audit: true,
        time: now().toISOString(),
        event: e.event,
        outcome: e.outcome,
        method: e.method,
        path: e.path,
        user: e.user && { id: e.user.id, email: e.user.email, memberId: e.user.memberId },
        submissionId: e.submissionId,
        uploadId: e.uploadId,
        sizeBytes: e.sizeBytes,
        detectedType: e.detectedType,
        ip: e.ip,
      };
      sink(JSON.stringify(line));
    },
  };
}
