/**
 * A map of the dashboard for the in-app assistant: what each page is for and what a person does there. Written by hand because no
 * guide describes the screens, and an assistant that cannot say "open Integrate, then Connect other tools" is not much help.
 *
 * Keep it true. It is searched like the guides, and a test checks that every path here is a real dashboard route. When a page is
 * added or changes, change it here and run `pnpm assistant:docs`.
 *
 * Mirror side: PUBLIC (packages/api is mirrored).
 */
import type { DocChunk } from "./chunk.js";

interface Page {
  path?: string;
  title: string;
  text: string;
}

const SOURCE = "Dashboard map";

export const APP_MAP: readonly Page[] = [
  {
    title: "What Loomail does",
    text: `Loomail sends lifecycle email that is driven by what people do in your product. Four things, in one direction: an event arrives (someone signed up, upgraded, went quiet), it belongs to a contact (one per user id), a flow decides what should happen, and the flow sends a message (one email). Flows are not drawn on a canvas: you write a plain-language prompt, Loomail compiles it once into a fixed plan, and the engine runs the plan without calling an AI. AI is used only to compile a prompt and to draft the copy of an email, before it goes to the approval queue. The main pages are Home, Integrate, Flows, Lifecycle, People, Segments, Approvals, Sent Mail, Knowledge Base, Analytics, Settings and Support, in the left sidebar.`,
  },
  {
    path: "/home",
    title: "Home",
    text: `Home is the overview. A new workspace sees a short setup checklist with what to do next: create your workspace, turn on your first flow, send your first event, add your business address, choose how email is sent, and get your first email delivered. It fills in as you finish steps. Once you are running it shows how things are going and what needs attention.`,
  },
  {
    path: "/integrate",
    title: "Integrate: getting data into Loomail",
    text: `Integrate is where data comes in. From top to bottom: "Your first event" and a "Send me a sample event" button to see it work with no setup; "Add Loomail to your app" with the website snippet and code for your framework; "API keys" (a publishable key for the browser snippet, secret keys for your servers); "Send a test event"; "Connect other tools"; and "Data warehouse". Use the snippet or an SDK or the API for events from your own product. Use Connect other tools for forms, bookings, stores and payments that can send a webhook. Use Data warehouse to read customer data you already keep in a database on a schedule; it is switched on by our team on request.`,
  },
  {
    path: "/integrate",
    title: "Integrate: Connect other tools (webhook sources)",
    text: `In Integrate, under Connect other tools, click Add a source and choose a Type. "Any JSON webhook" works with Zapier, Make, n8n or your own app: you say where the person, the event name and the traits are in the JSON. Ready-made choices fill that in for you: Typeform, Tally and Webflow forms, Cal.com bookings, Gumroad, Shopify, WooCommerce customers and Segment, and Stripe for payments. After saving, Loomail shows an address to give the other tool, and (for most tools) a token. Each source has a log of what it received and what Loomail did with it, which is the first place to look when nothing arrives.`,
  },
  {
    path: "/integrate",
    title: "Integrate: Data warehouse (read from your database)",
    text: `Data warehouse is not on by default, because it can mean a lot of data. If you see "Request access" under Data warehouse in Integrate, click it and tell us which database you use, roughly how much data, and how often it should refresh. Our team replies by email and switches it on with you. Once it is on: in Integrate, under Data warehouse, click Connect a warehouse and choose Postgres, MySQL or SQL Server. You enter the host, port, database, user and password, then write one SELECT query and say which column marks new or changed rows. Loomail reads it on a schedule (about hourly) and turns each row into a contact, traits and an event. If the database is not reachable from the internet, tick "My database is not reachable from the internet" and connect through an SSH server. Use "Test the query" before saving: it shows the first rows and what each would become, or a plain reason it failed. "Sync now" runs it immediately.`,
  },
  {
    path: "/flows",
    title: "Flows: your automations",
    text: `Flows lists your automations and is where you create them. A flow is a trigger (an event, or a person entering a segment), a plan of steps with delays, and settings such as who approves. You can start from the library of ready-made flows and the starter packs, or click to create a new flow and describe it in plain language. In the flow editor you write the prompt, Loomail compiles it into a plan you can read, you can send a test email to yourself, and when you are happy you turn the flow on. A flow does nothing until it is active and compiled.`,
  },
  {
    path: "/lifecycle",
    title: "Lifecycle",
    text: `Lifecycle shows where your contacts are in their journey: how many are signed up, activated, engaged, at risk, dormant, churned or resurrected, and how people moved between those states over time. Each contact's state is worked out from the events they send.`,
  },
  {
    path: "/people",
    title: "People: your contacts",
    text: `People lists your contacts and lets you search them. Open a person to see their traits, their events, the flows they are in and the emails they received. Use the import button to bring in a CSV of contacts. A contact needs an email address before Loomail can email them; one with only a user id can still have events and be in flows, but no message can be sent.`,
  },
  {
    path: "/segments",
    title: "Segments",
    text: `Segments are saved groups of people, described by rules rather than picked by hand (for example, people on a trial who have not sent an event in a week). Create one, describe who belongs, and the preview shows who matches right now. You can look at exactly those people, or start a flow from a segment so that people entering it are enrolled.`,
  },
  {
    path: "/approvals",
    title: "Approvals: review emails before they send",
    text: `Approvals is the queue of emails waiting for a person to review them. Each shows who it is for and the drafted copy; you approve or reject it, one at a time or in bulk. Emails leave only after approval, unless the flow is set to send automatically, in which case they skip this queue. If nothing is arriving here, check that a flow is active and that its approval mode is not automatic.`,
  },
  {
    path: "/sent",
    title: "Sent Mail and suppressions",
    text: `Sent Mail lists every message that left the pipeline: who received it, when, and its status. A message's status moves forward as things happen: sent (it left), opened (the person opened it), clicked (they clicked a link), or bounced (the address could not receive it). Click one to see it in full. The Suppressions page lists addresses that will never receive mail: hard bounces, complaints, unsubscribes and addresses you blocked by hand. You can add or import addresses to block.`,
  },
  {
    path: "/kb",
    title: "Knowledge Base",
    text: `The Knowledge Base holds short entries about your product (what it does, how to do common things, your tone). When Loomail's AI drafts an email, it can use these entries so the copy is accurate and sounds like you. Add entries here, open one to edit it.`,
  },
  {
    path: "/analytics",
    title: "Analytics",
    text: `Analytics shows how your sending is performing over the last several days: how many emails were sent, opened and clicked, and how that is trending. You can change the period shown.`,
  },
  {
    path: "/settings/plan",
    title: "Settings: Plan and usage",
    text: `Settings, then Plan and usage, shows your plan, whether you are in a trial and how many days are left, and your usage this month (contacts, emails, and AI). It is also where you upgrade or manage a subscription. This page only appears when plans are enforced on the install.`,
  },
  {
    path: "/settings/team",
    title: "Settings: Team",
    text: `Settings, then Team, lists the people in your workspace. Owners can create an invite for a teammate (you give them the invite link), choose whether they join as a member or an owner, change a person's role later, and remove people. Everyone in a workspace sees the same data.`,
  },
  {
    path: "/settings/profile",
    title: "Settings: Profile",
    text: `Settings, then Profile, is where you change your own name and your sign-in email. Changing the email sends a confirmation link to the new address first.`,
  },
  {
    path: "/settings/data",
    title: "Settings: Data and deletion",
    text: `Settings, then Data and deletion, lets the workspace owner download all of the workspace's data as a file, or schedule the workspace for permanent deletion. Deletion has a grace period during which it can be cancelled; after it, everything is erased for good.`,
  },
  {
    path: "/settings/llm",
    title: "Settings: AI provider",
    text: `Settings, then AI provider, shows where the AI that compiles flows and drafts emails comes from: Loomail's own AI (within your plan's monthly allowance) or an AI provider key you add yourself. If a flow will not compile or drafts will not generate, check this page first.`,
  },
  {
    path: "/settings/transport",
    title: "Settings: Email sending",
    text: `Settings, then Email sending, is where you set up how email leaves: connect your own email provider (Resend, or any SMTP server) with a from address, or use managed sending where it is offered. Nothing can be emailed until sending is set up, and the page shows a warning until it is. Send yourself a test to check it works.`,
  },
  {
    path: "/settings/pace",
    title: "Settings: Sending pace",
    text: `Settings, then Sending pace, controls how fast and when email goes out: a maximum number of emails per contact per day and per week, a minimum gap between emails to the same person, a batch size, and a send window of days and hours. If emails seem to be held back, a window or a limit here may be the reason.`,
  },
  {
    path: "/settings/branding",
    title: "Settings: Branding",
    text: `Settings, then Branding, sets how your emails look: your brand name, a logo (by its web address), an accent colour and footer text, which wrap every message. You can send yourself a test email to see the result.`,
  },
  {
    path: "/settings/postal",
    title: "Settings: Postal address",
    text: `Settings, then Postal address, is where you enter your business's postal address. Email law requires it in the footer of marketing email, so Loomail will not send until it is set. A warning shows on the settings menu while it is missing.`,
  },
  {
    path: "/support",
    title: "Support",
    text: `Support, in the sidebar, is how you reach the people who run Loomail. Choose what it is about, write a subject and a message, and send it. Replies arrive by email and in the conversation on the same page, where you can also reply or mark it resolved. Use it for anything the assistant cannot answer, or for a problem with your account.`,
  },
  {
    title: "Why are my emails not sending? A checklist",
    text: `Work through these in order. 1) Is a flow active and compiled? 2) Did an event arrive that matches its trigger (Integrate shows incoming events; People shows a person's events)? 3) Does the person have an email address? 4) Is the email waiting in Approvals? 5) Is email sending set up in Settings, Email sending, and the postal address filled in under Settings, Postal address? 6) Is the address on the Suppressions list? 7) Is a sending window or frequency limit in Sending pace holding it back? 8) Look in Sent Mail for the message and its status. If everything looks right, send a Support request with the flow and the person's id.`,
  },
  {
    title: "What the assistant can and cannot do",
    text: `The assistant explains how Loomail works and points you to the right page. It cannot change anything in your workspace, send email, or see your contacts' data. It does not know your passwords or keys, and you should never paste them. For problems it cannot solve, it can send your question to Support.`,
  },
];

/** The map as searchable pieces. */
export function appMapChunks(): DocChunk[] {
  return APP_MAP.map((p, i) => ({
    id: `app#${i}`,
    source: SOURCE,
    heading: p.title,
    text: p.text,
    ...(p.path ? { path: p.path } : {}),
  }));
}
