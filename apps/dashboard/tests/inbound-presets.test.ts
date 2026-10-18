/** Ready-made tool settings: each one builds valid settings, and the list is well formed. */
import { describe, it, expect } from "vitest";
import { buildGenericConfig, emptyGenericForm, genericFormFromConfig } from "../src/inbound-sources.js";
import { PRESET_GROUPS, TOOL_PRESETS, presetById } from "../src/inbound-presets.js";

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
});
