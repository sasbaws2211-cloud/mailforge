/**
 * A/B tests and holdouts: how each version of a random split did.
 *
 * Shown on the flow page when the flow has a random split that people have been assigned to. For each split: who
 * was assigned each version, how many reached the goal, and the emails sent, opened and clicked on that version's
 * own path, with a plain verdict that says "too early" when there is not enough to go on.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import type { FlowResults, SplitTestResult } from "../api.js";
import { useFlowResults } from "../flows.js";
import { describeSplitVerdict, goalRate, sentRate, versionName } from "../split.js";

export function SplitResults({ flowId }: { flowId: string }) {
  const results = useFlowResults(flowId, 30);
  if (results.isLoading || results.isError || !results.data) return null;
  return <SplitResultsView results={results.data} />;
}

/** The panel itself, separate from loading so it can be shown and tested on its own. Renders nothing without a split. */
export function SplitResultsView({ results }: { results: Pick<FlowResults, "split_tests" | "range_days"> }) {
  const tests = results.split_tests ?? [];
  if (tests.length === 0) return null;
  return (
    <div className="mt-4 rounded-lg border border-border bg-card px-5 py-4" aria-label="A/B tests">
      <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">A/B tests</p>
      <div className="mt-3 space-y-5">
        {tests.map((t, i) => (
          <SplitTest key={t.node_order} test={t} label={tests.length > 1 ? `Split ${i + 1}` : "Split"} />
        ))}
      </div>
      <p className="mt-4 text-[12px] text-muted-foreground">
        People assigned in the last {results.range_days} days. Opens are approximate: some mail apps load images automatically.
      </p>
    </div>
  );
}

function SplitTest({ test: t, label }: { test: SplitTestResult; label: string }) {
  const rows = [
    { which: "a" as const, v: t.a },
    { which: "b" as const, v: t.b },
  ];
  return (
    <section aria-label={label}>
      <h3 className="text-[14px] font-semibold text-foreground">
        {label}
        {t.percent_a !== null && <span className="font-normal text-muted-foreground"> · {t.percent_a}% / {100 - t.percent_a}%</span>}
        {!t.in_plan && <span className="font-normal text-muted-foreground"> · no longer in the flow</span>}
      </h3>
      <p className="mt-1 text-[14px] text-foreground" data-testid="split-verdict">
        {describeSplitVerdict(t)}
      </p>
      <table className="mt-2 w-full text-[13px]">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1 font-medium">Version</th>
            <th className="py-1 text-right font-medium">People</th>
            <th className="py-1 text-right font-medium">Reached the goal</th>
            <th className="py-1 text-right font-medium">Sent</th>
            <th className="py-1 text-right font-medium">Opened</th>
            <th className="py-1 text-right font-medium">Clicked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ which, v }) => (
            <tr key={which} className="border-t border-border">
              <td className="py-1.5 text-foreground">{versionName(which, v)}</td>
              <td className="py-1.5 text-right tabular-nums text-foreground">{v.assigned.toLocaleString("en-US")}</td>
              <td className="py-1.5 text-right tabular-nums text-foreground">
                {t.comparison ? (
                  <>
                    {v.converted.toLocaleString("en-US")} <span className="text-muted-foreground">({goalRate(v)})</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </td>
              <td className="py-1.5 text-right tabular-nums text-foreground">{v.holdout ? <span className="text-muted-foreground">none</span> : v.sent.toLocaleString("en-US")}</td>
              <td className="py-1.5 text-right tabular-nums text-foreground">{v.holdout ? "-" : sentRate(v, v.opened)}</td>
              <td className="py-1.5 text-right tabular-nums text-foreground">{v.holdout ? "-" : sentRate(v, v.clicked)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      
    </section>
  );
}
