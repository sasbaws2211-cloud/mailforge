/**
 * Template renderer. The implementation lives in @loomail/core so the API can render the same
 * templates (for test sends) exactly as the drain does; this module keeps the worker's imports
 * stable.
 *
 * Mirror side: PUBLIC (packages/worker is mirrored).
 */
export {
  renderTemplate,
  escapeTemplateHtml as escapeHtml,
  SUPPORTED_VARIABLE_PREFIXES,
} from "@loomail/core";
export type { TemplateContext, TemplateRenderOutcome, RenderResult, RenderError } from "@loomail/core";
