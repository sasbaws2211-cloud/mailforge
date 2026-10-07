/**
 * "What the AI can use" help under the flow prompt box.
 *
 * A closed-by-default disclosure so it does not crowd the editor, but one click away at the moment a
 * person is about to write a prompt that the AI cannot satisfy. The wording lives in
 * ../prompt-guidance.ts (and is mirrored in guide/FLOW-PROMPTS.md).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import {
  AI_CANNOT_USE,
  AI_CAN_USE,
  PROMPT_EXAMPLE_FAILS,
  PROMPT_EXAMPLE_FAILS_WHY,
  PROMPT_EXAMPLE_WORKS,
} from "../prompt-guidance.js";

export function PromptGuidance() {
  return (
    <details className="mb-3 rounded-md border border-border bg-secondary px-3.5 py-2.5 text-[14px] leading-relaxed text-muted-foreground">
      <summary className="cursor-pointer select-none font-medium text-foreground">What the AI can use when it writes each email</summary>
      <div className="mt-2 space-y-3">
        <div>
          <p className="text-foreground">The AI is given:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {AI_CAN_USE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="text-foreground">It is not given:</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {AI_CANNOT_USE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <p>
          Write the prompt around what it is given. If a prompt needs something it is not given, the AI cannot include it and the
          quality check holds the email back instead of sending something generic.
        </p>
        <div className="space-y-1.5">
          <p>
            <span className="font-medium text-foreground">Works: </span>
            {PROMPT_EXAMPLE_WORKS}
          </p>
          <p>
            <span className="font-medium text-foreground">Does not: </span>
            {PROMPT_EXAMPLE_FAILS}
          </p>
          <p>{PROMPT_EXAMPLE_FAILS_WHY}</p>
        </div>
      </div>
    </details>
  );
}
