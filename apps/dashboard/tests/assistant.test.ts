/** The in-app assistant, the dashboard's side: what is sent, how an answer is shown, and remembering the conversation. */
import { describe, it, expect } from "vitest";
import {
  MAX_KEPT,
  MAX_QUESTION,
  MAX_SENT,
  answerBlocks,
  inlineSegments,
  loadChat,
  messagesToSend,
  questionProblem,
  saveChat,
  subjectFrom,
  suggestionsFor,
  transcript,
  type ChatMessage,
} from "../src/assistant.js";

const user = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "u" + content.length + Math.random(), role: "user", content, ...extra });
const bot = (content: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: "a" + content.length + Math.random(), role: "assistant", content, ...extra });

describe("what is sent with a question", () => {
  it("sends the real conversation, without notices, ending on the person's question", () => {
    const sent = messagesToSend([user("How do I connect Typeform?"), bot("Open Integrate."), user("and Tally?"), bot("The assistant hit a limit.", { notice: true })]);
    expect(sent).toEqual([
      { role: "user", content: "How do I connect Typeform?" },
      { role: "assistant", content: "Open Integrate." },
      { role: "user", content: "and Tally?" },
    ]);
  });

  it("keeps only the newest turns, starts with the person's words, and clips a long message", () => {
    const many: ChatMessage[] = [];
    for (let i = 0; i < 30; i++) many.push(i % 2 === 0 ? user(`q${i}`) : bot(`a${i}`));
    const sent = messagesToSend(many);
    expect(sent.length).toBeLessThanOrEqual(MAX_SENT);
    expect(sent[0]!.role).toBe("user");
    expect(sent.at(-1)).toEqual({ role: "assistant", content: "a29" });
    expect(messagesToSend([user("x".repeat(MAX_QUESTION + 500))])[0]!.content).toHaveLength(MAX_QUESTION);
    expect(messagesToSend([])).toEqual([]);
    expect(messagesToSend([bot("only the assistant spoke")])).toEqual([]);
  });

  it("checks a question before it is sent", () => {
    expect(questionProblem("How do I do this?")).toBeNull();
    expect(questionProblem("   ")).toBe("Type a question first.");
    expect(questionProblem("x".repeat(MAX_QUESTION + 1))).toMatch(/under 2000/);
    expect(questionProblem("x".repeat(MAX_QUESTION))).toBeNull();
  });
});

describe("handing the conversation to Support", () => {
  it("writes the conversation as plain text, within a limit, without notices", () => {
    const t = transcript([user("Why no email?"), bot("Check sending."), bot("note", { notice: true }), user("Still stuck")]);
    expect(t).toBe("Me: Why no email?\n\nAssistant: Check sending.\n\nMe: Still stuck");
    const long = transcript([user("x".repeat(3000)), bot("y".repeat(3000))], 4800);
    expect(long.length).toBeLessThanOrEqual(4800);
    expect(long.startsWith("…")).toBe(true);
    expect(long.endsWith("y")).toBe(true); // the end of the conversation is what matters most
  });

  it("makes a subject from what the person last asked", () => {
    expect(subjectFrom([user("First question"), bot("An answer"), user("My emails\nnever   arrive")])).toBe("My emails never arrive");
    expect(subjectFrom([user("x".repeat(300))])).toHaveLength(120);
    expect(subjectFrom([])).toBe("Help from the assistant");
    expect(subjectFrom([user("ok")])).toBe("Help from the assistant");
  });
});

describe("showing an answer safely", () => {
  it("splits a line into text, bold and code, and nothing else", () => {
    expect(inlineSegments("Open **Settings** then run `ssh-keygen -lf -` now")).toEqual([
      { kind: "text", text: "Open " },
      { kind: "bold", text: "Settings" },
      { kind: "text", text: " then run " },
      { kind: "code", text: "ssh-keygen -lf -" },
      { kind: "text", text: " now" },
    ]);
    expect(inlineSegments("plain")).toEqual([{ kind: "text", text: "plain" }]);
    expect(inlineSegments("")).toEqual([]);
    expect(inlineSegments("unclosed **bold and `code")).toEqual([{ kind: "text", text: "unclosed **bold and `code" }]);
  });

  it("never turns anything into a link, an image or markup: it stays text", () => {
    const evil = "[click](javascript:alert(1)) ![x](https://evil.example/p.png) <img src=x onerror=alert(1)> <script>x()</script>";
    const segs = inlineSegments(evil);
    expect(segs).toEqual([{ kind: "text", text: evil }]);
  });

  it("reads paragraphs and simple lists", () => {
    expect(answerBlocks("First line\nsecond line.\n\nSteps:\n1. Open Integrate\n2. Click Add\n\n- one\n- two")).toEqual([
      { kind: "paragraph", text: "First line second line." },
      { kind: "paragraph", text: "Steps:" },
      { kind: "list", ordered: true, items: ["Open Integrate", "Click Add"] },
      { kind: "list", ordered: false, items: ["one", "two"] },
    ]);
    expect(answerBlocks("")).toEqual([]);
    expect(answerBlocks("1) first\n- then a bullet")).toEqual([
      { kind: "list", ordered: true, items: ["first"] },
      { kind: "list", ordered: false, items: ["then a bullet"] },
    ]);
  });
});

describe("remembering the conversation while the tab is open", () => {
  const store = (initial?: string) => {
    let value = initial ?? null;
    return { getItem: () => value, setItem: (_k: string, v: string) => void (value = v), removeItem: () => void (value = null), peek: () => value };
  };

  it("saves and reads it back, keeping what matters", () => {
    const s = store();
    const chat = [user("Hi"), bot("Hello", { sources: [{ id: "1", source: "Guide", heading: "A > B", path: "/integrate" }], suggestSupport: true }), bot("note", { notice: true, ticketId: "abc" })];
    saveChat(chat, s);
    expect(loadChat(s)).toEqual(chat);
  });

  it("starts empty when there is nothing, or when what is there is broken, wrong or from another version", () => {
    expect(loadChat(store())).toEqual([]);
    expect(loadChat(store("not json"))).toEqual([]);
    expect(loadChat(store('{"a":1}'))).toEqual([]);
    expect(loadChat(store('[1,"x",null,{"role":"system","content":"x","id":"1"},{"role":"user","id":"2"}]'))).toEqual([]);
    expect(loadChat(null)).toEqual([]);
    expect(loadChat({ getItem: () => { throw new Error("blocked"); } })).toEqual([]);
  });

  it("does not trust what is stored: it is only ever shown as text, and its size is bounded", () => {
    const stored = JSON.stringify([{ id: "1", role: "assistant", content: "x".repeat(9000), sources: [{ heading: "h", source: "s", id: "z", path: "javascript:alert(1)" }, { nope: 1 }, "str"] }]);
    const [m] = loadChat(store(stored));
    expect(m!.content).toHaveLength(4000);
    expect(m!.sources).toHaveLength(1); // the malformed ones are dropped
    const many = Array.from({ length: MAX_KEPT + 20 }, (_, i) => user(`m${i}`, { id: `i${i}` }));
    expect(loadChat(store(JSON.stringify(many)))).toHaveLength(MAX_KEPT);
  });

  it("clears the saved copy when the conversation is cleared, and survives storage that refuses to save", () => {
    const s = store();
    saveChat([user("Hi")], s);
    expect(s.peek()).not.toBeNull();
    saveChat([], s);
    expect(s.peek()).toBeNull();
    expect(() => saveChat([user("Hi")], { setItem: () => { throw new Error("quota"); }, removeItem: () => {} })).not.toThrow();
    expect(() => saveChat([user("Hi")], null)).not.toThrow();
  });
});

describe("starter questions", () => {
  it("fit the page, and there is always something to offer", () => {
    expect(suggestionsFor("/integrate")[0]).toMatch(/first event/);
    expect(suggestionsFor("/flows/abc/edit")[0]).toMatch(/flow/i);
    expect(suggestionsFor("/settings/transport")).toContain("How do I set up email sending?");
    expect(suggestionsFor("/something/else").length).toBeGreaterThanOrEqual(2);
    for (const p of ["/home", "/people", "/segments", "/approvals", "/sent", "/kb", "/"]) {
      const list = suggestionsFor(p);
      expect(list.length, p).toBeGreaterThanOrEqual(2);
      expect(list.length, p).toBeLessThanOrEqual(3);
      expect(new Set(list).size, p).toBe(list.length);
    }
  });
});
