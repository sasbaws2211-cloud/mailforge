/**
 * "Add Loomail to your app": a tab per framework, each with numbered steps and code that already has this workspace's
 * address (and the publishable key, when it is known) in it. The content comes from ../integration-snippets.ts.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMemo, useState } from "react";
import { FRAMEWORKS, PACKAGE_NAME, buildGuide, needsPackage, type FrameworkId } from "../integration-snippets.js";
import { CodeBlock } from "./code-block.js";

const STORAGE_KEY = "loomail-integrate-framework";

function remembered(): FrameworkId {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v && FRAMEWORKS.some((f) => f.id === v)) return v as FrameworkId;
  } catch {
    /* storage unavailable: start on HTML */
  }
  return "html";
}

export function FrameworkGuide({ origin, rawKey }: { origin: string; rawKey: string | null }) {
  const [selected, setSelected] = useState<FrameworkId>(remembered);
  const guide = useMemo(() => buildGuide(selected, { origin, key: rawKey }), [selected, origin, rawKey]);

  const choose = (id: FrameworkId) => {
    setSelected(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* not remembered */
    }
  };

  return (
    <div>
      <div role="tablist" aria-label="Framework" className="flex flex-wrap gap-1.5">
        {FRAMEWORKS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            id={`fw-tab-${f.id}`}
            aria-selected={selected === f.id}
            aria-controls="fw-panel"
            onClick={() => choose(f.id)}
            className={
              "rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors " +
              (selected === f.id ? "border-accent-deep bg-accent-soft text-foreground" : "border-border bg-card text-muted-foreground hover:text-foreground")
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <div id="fw-panel" role="tabpanel" aria-labelledby={`fw-tab-${selected}`} className="mt-4">
        <p className="text-[14px] text-muted-foreground">{guide.summary}</p>
        <ol className="mt-4 space-y-5">
          {guide.steps.map((s, i) => (
            <li key={`${selected}-${i}`} data-testid="guide-step">
              <p className="text-[14px] font-medium text-foreground">
                {guide.steps.length > 1 ? `${i + 1}. ` : ""}
                {s.title}
                {s.file && <span className="ml-2 font-mono text-[12px] font-normal text-muted-foreground">{s.file}</span>}
              </p>
              <div className="mt-2">
                <CodeBlock id={`${selected}-${i}`} code={s.code} />
              </div>
              {s.note && <p className="mt-2 text-[13px] text-muted-foreground">{s.note}</p>}
            </li>
          ))}
        </ol>
        {needsPackage(selected) && (
          <p className="mt-5 text-[13px] text-muted-foreground">
            The <code className="font-mono">{PACKAGE_NAME}</code> package works in every browser and records a page view on each
            client-side route change. If you would rather not add a dependency, the plain HTML snippet works in any framework.
          </p>
        )}
      </div>
    </div>
  );
}
