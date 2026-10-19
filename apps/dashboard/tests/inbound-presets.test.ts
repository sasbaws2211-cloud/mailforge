/** Ready-made tool settings: each one builds valid settings, and the list is well formed. */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SourceForm } from "../src/components/inbound-sources-card.js";
import { buildGenericConfig, emptyGenericForm, genericFormFromConfig } from "../src/inbound-sources.js";
import { PAUSED_PRESETS, PRESET_GROUPS, TOOL_PRESETS, presetById } from "../src/inbound-presets.js";

describe("tool presets", () => {
  it("has a unique id and label for each, in a known group, with setup steps", () => {
    expect(new Set(TOOL_PRESETS.map((p) => p.id)).size).toBe(TOOL_PRESETS.length);
    expect(new Set(TOOL_PRESETS.map((p) => p.label)).size).toBe(TOOL_PRESETS.length);
    for (const p of TOOL_PRESETS) {
      expect(PRESET_GROUPS, p.id).toContain(p.group);
      expect(p.steps.length, p.id).toBeGreaterThan(0);
      expect(p.summary, p.id).not.toBe("");
    }
  });

  it("each one builds settings the API accepts, and reads back the same", () => {
    for (const p of TOOL_PRESETS) {
      const form = { ...emptyGenericForm(), ...p.form };
      const built = buildGenericConfig(form);
      expect(built.ok, `${p.id}: ${built.ok ? "" : built.problems.join(" ")}`).toBe(true);
      if (!built.ok) continue;
      expect(genericFormFromConfig(built.config), p.id).toMatchObject({ eventMode: form.eventMode, eventValue: form.eventValue, emailPath: form.emailPath ?? "", eventIdPath: form.eventIdPath ?? "" });
    }
  });

  it("every one identifies the person by an email or a user id, and names an event", () => {
    for (const p of TOOL_PRESETS) {
      expect(Boolean(p.form.emailPath || p.form.userIdPath), p.id).toBe(true);
      expect(p.form.eventMode, p.id).not.toBe("none");
      expect(p.form.eventValue, p.id).toBeTruthy();
    }
  });

  it("looks a preset up by id", () => {
    expect(presetById("tally")?.label).toBe("Tally");
    expect(presetById("nope")).toBeUndefined();
  });

  it("Segment is not offered in the menu while it is tested further, but is kept and still valid", () => {
    expect(TOOL_PRESETS.some((p) => p.id === "segment")).toBe(false);
    expect(presetById("segment")).toBeUndefined();
    expect(PRESET_GROUPS).not.toContain("Data pipelines");
    const segment = PAUSED_PRESETS.find((p) => p.id === "segment");
    expect(segment?.label).toBe("Segment");
    const built = buildGenericConfig({ ...emptyGenericForm(), ...segment!.form });
    expect(built.ok).toBe(true);
  });

  it("every group in the menu has at least one tool (no empty headings)", () => {
    for (const g of PRESET_GROUPS) expect(TOOL_PRESETS.some((p) => p.group === g), g).toBe(true);
  });
});

describe("the Type menu on the add-a-source form", () => {
  const html = renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(SourceForm, { onCancel: () => {}, onSaved: () => {} })),
  );
  const menu = /<select[^>]*id="source-kind"[\s\S]*?<\/select>/.exec(html)?.[0] ?? "";
  it("found the menu to check", () => {
    expect(menu.length).toBeGreaterThan(200);
  });
  const group = (label: string) => {
    const start = menu.indexOf(`<optgroup label="${label}">`);
    if (start < 0) return null;
    return menu.slice(start, menu.indexOf("</optgroup>", start));
  };

  it("puts Stripe under Payments and subscriptions, and nowhere else", () => {
    const payments = group("Payments and subscriptions");
    expect(payments).not.toBeNull();
    expect(payments).toContain('value="stripe"');
    expect(payments).toContain(">Stripe<");
    expect((menu.match(/value="stripe"/g) ?? []).length).toBe(1);
    for (const other of ["Forms and waitlists", "Booking", "Selling"]) expect(group(other) ?? "", other).not.toContain("stripe");
  });

  it("no longer offers Segment, and has no Data pipelines heading", () => {
    expect(menu).not.toContain("tool:segment");
    expect(menu).not.toContain(">Segment<");
    expect(menu).not.toContain("Data pipelines");
  });

  it("keeps the other groups and tools, and the generic option first", () => {
    for (const g of PRESET_GROUPS) expect(group(g), g).not.toBeNull();
    for (const p of TOOL_PRESETS) expect(menu, p.id).toContain(`value="tool:${p.id}"`);
    expect(menu.indexOf('value="generic"')).toBeLessThan(menu.indexOf("<optgroup"));
  });

  it("still does not offer Paystack or Flutterwave for new sources", () => {
    expect(menu).not.toContain('value="paystack"');
    expect(menu).not.toContain('value="flutterwave"');
  });
});
