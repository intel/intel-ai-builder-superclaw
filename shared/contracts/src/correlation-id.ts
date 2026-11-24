/**
 * The correlation id grammar the Connector IPC and the host approval API share.
 *
 * One definition because one id crosses both: the Connector's approval refusal carries the
 * `approval_id` the Sandbox Manager lists and the operator decides, and the three audit logs
 * are joined on it. Browser-safe, because the frontend's approval adapter parses with it.
 */
import { z } from "zod";

export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const CorrelationIdSchema = z.string().regex(CORRELATION_ID_PATTERN);
