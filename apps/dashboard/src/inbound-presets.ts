/**
 * Ready-made settings for tools that send webhooks, on top of the generic JSON source. Choosing one fills in the form
 * (where the person, the event and its id are in that tool's payload) and shows where to paste the address.
 *
 * Every preset carries a sample of what the tool sends, taken from its documentation, and the tests run each one through the
 * real mapper. `confidence` says how far the field names are backed by the tool's own docs:
 *   docs    the payload shape is in the tool's official documentation
 *   partly  the field list is documented but no full webhook example was found: send a test and read the source's log
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import type { GenericForm } from "./inbound-sources.js";

export interface ToolPreset {
  id: string;
  label: string;
  group: "Forms and waitlists" | "Booking" | "Selling" | "Data pipelines";
  /** One line under the type selector. */
  summary: string;
  /** Where to click in the other tool, in order. The address (with its token) is shown once the source is saved. */
  steps: string[];
  /** Is the token carried in the address, or can the tool also set a header? */
  token: "address" | "address-or-header";
  confidence: "docs" | "partly";
  /** Said under the steps, when the setup has a catch. */
  note?: string;
  /**
   * The tool signs its calls with a secret both sides know (an HMAC-SHA256 of the body). When present, the form offers to check that
   * signature instead of a token: no token in the address.
   */
  signature?: { header: string; encoding: "either" | "hex" | "base64"; prefix?: string; secretHint: string };
  form: Partial<GenericForm>;
  /** What the tool sends, as an object. A tool that posts form fields (Gumroad) is flat text. */
  sample: Record<string, unknown>;
  /** How the sample is sent. */
  sampleAs: "json" | "form";
  /** Headers the tool sends with it that the settings read (lower case), for the tests. */
  sampleHeaders?: Record<string, string>;
  /** What the sample should become, for the tests. */
  expect: { email: string; event: string };
}

const trait = (name: string, path: string) => ({ name, path });

export const TOOL_PRESETS: readonly ToolPreset[] = [
  {
    id: "typeform",
    label: "Typeform",
    group: "Forms and waitlists",
    summary: "A person fills in a Typeform: record them and the submission.",
    steps: [
      "In Typeform open your form, then Connect, then Webhooks, then Add a webhook.",
      "Paste the address below as the destination URL. Typeform cannot send headers, so the token is part of the address.",
      "To tie the submission to one of your own users, pass your id to the form as a hidden field called user_id. Without it the person is matched by the email answer.",
    ],
    token: "address",
    confidence: "docs",
    note: "Answers are found by type, so a skipped question does not move them. A retry of the same submission is recorded once.",
    form: {
      eventMode: "fixed",
      eventValue: "typeform_submitted",
      userIdPath: "form_response.hidden.user_id",
      emailPath: "form_response.answers[type=email].email",
      eventIdPath: "event_id",
      traits: [trait("typeform_form", "form_response.form_id")],
    },
    sampleAs: "json",
    sample: {
      event_id: "LtWXD3crgy",
      event_type: "form_response",
      form_response: {
        form_id: "lT4Z3j",
        token: "a3a12ec67a1365927098a606107fac15",
        submitted_at: "2018-01-18T18:17:02Z",
        hidden: { user_id: "abc123456" },
        answers: [
          { type: "text", text: "It's cold right now!", field: { id: "DlXFaesGBpoF", type: "long_text" } },
          { type: "email", email: "laura@example.com", field: { id: "SMEUb7VJz92Q", type: "email" } },
        ],
      },
    },
    expect: { email: "laura@example.com", event: "typeform_submitted" },
  },
  {
    id: "tally",
    label: "Tally",
    group: "Forms and waitlists",
    summary: "A person joins a waitlist or fills in a Tally form.",
    steps: [
      "In Tally open your form, then Integrations, then Webhooks, then Connect.",
      "Paste the address below as the endpoint URL. Tally can also send a header: you may add Authorization: Bearer with the token instead.",
      "Make sure the form has an email question. The person is matched by it.",
    ],
    token: "address-or-header",
    confidence: "docs",
    note: "A retry of the same submission is recorded once. Tally can also sign its calls: choose that below, turn on the signing secret in Tally and paste the same text here.",
    signature: { header: "tally-signature", encoding: "either", secretHint: "The signing secret you set on the webhook in Tally. Any long random text, the same on both sides." },
    form: {
      eventMode: "fixed",
      eventValue: "tally_form_submitted",
      emailPath: "data.fields[type=INPUT_EMAIL].value",
      eventIdPath: "eventId",
      traits: [trait("tally_form", "data.formName")],
    },
    sampleAs: "json",
    sample: {
      eventId: "a1b2c3d4-0000-4000-8000-000000000001",
      eventType: "FORM_RESPONSE",
      createdAt: "2023-06-28T15:00:21.889Z",
      data: {
        responseId: "2wgx4n",
        submissionId: "2wgx4n",
        respondentId: "dwQKYm",
        formId: "VwbNEw",
        formName: "Waitlist",
        fields: [
          { key: "question_a", label: "Your name", type: "INPUT_TEXT", value: "Ada" },
          { key: "question_b", label: "Your email", type: "INPUT_EMAIL", value: "ada@example.com" },
        ],
      },
    },
    expect: { email: "ada@example.com", event: "tally_form_submitted" },
  },
  {
    id: "webflow",
    label: "Webflow form",
    group: "Forms and waitlists",
    summary: "A visitor submits a form on your Webflow site.",
    steps: [
      "In Webflow open Site settings, then Apps & integrations, then Webhooks, then Add webhook, and choose the Form submission trigger.",
      "Paste the address below as the destination URL. The token is part of the address.",
      "Submit the form once and open this source's log. The email is read from the form field named email: if your field has another name (Email, Work Email), edit the source and change that path.",
    ],
    token: "address",
    confidence: "partly",
    note: "Webflow's documentation lists the fields of the payload but its data keys are your own form's field names, so check the first delivery in the log.",
    form: {
      eventMode: "fixed",
      eventValue: "webflow_form_submitted",
      emailPath: "payload.data.email",
      eventIdPath: "payload.id",
      traits: [trait("webflow_form", "payload.name")],
    },
    sampleAs: "json",
    sample: {
      triggerType: "form_submission",
      payload: {
        name: "Waitlist",
        siteId: "62749158efef318abc8d5a0f",
        data: { "First Name": "Zaphod", email: "zaphod@heartofgold.ai" },
        submittedAt: "2022-09-14T12:35:16.117Z",
        id: "6321ca84df3949bfc6752327",
        formId: "6321ca84df3949bfc6752328",
        formElementId: "4e038f0b-f2d6-4f5b-ab7f-b4eaf2f1cc02",
        localeId: null,
      },
    },
    expect: { email: "zaphod@heartofgold.ai", event: "webflow_form_submitted" },
  },
  {
    id: "calcom",
    label: "Cal.com",
    group: "Booking",
    summary: "Someone books, reschedules or cancels a meeting.",
    steps: [
      "In Cal.com open Settings, then Developer, then Webhooks, then New.",
      "Paste the address below as the subscriber URL. The token is part of the address.",
      "Tick the events you want (for example Booking created). Each event's name, such as BOOKING_CREATED, becomes the event name in Loomail.",
    ],
    token: "address",
    confidence: "docs",
    note: "The person is the first attendee, the one who booked. A booking created twice is recorded once, and its cancellation is a separate event. Cal.com can also sign its calls: choose that below and paste the webhook's secret.",
    signature: { header: "x-cal-signature-256", encoding: "either", secretHint: "The secret on the webhook in Cal.com." },
    form: {
      eventMode: "path",
      eventValue: "triggerEvent",
      emailPath: "payload.attendees.0.email",
      eventIdPath: "payload.uid",
      traits: [trait("name", "payload.attendees.0.name"), trait("last_booking_start", "payload.startTime")],
    },
    sampleAs: "json",
    sample: {
      triggerEvent: "BOOKING_CREATED",
      createdAt: "2024-01-01T00:00:00.000Z",
      payload: {
        title: "Strategy Session between Organizer and Guest",
        startTime: "2024-01-01T10:00:00Z",
        endTime: "2024-01-01T10:15:00Z",
        organizer: { id: 1, name: "Organizer Name", email: "organizer@example.com" },
        attendees: [{ email: "guest@example.com", name: "Guest User", timeZone: "UTC" }],
        uid: "unique-booking-id",
        bookingId: 100,
        status: "ACCEPTED",
      },
    },
    expect: { email: "guest@example.com", event: "BOOKING_CREATED" },
  },
  {
    id: "gumroad",
    label: "Gumroad",
    group: "Selling",
    summary: "Someone buys from your Gumroad store.",
    steps: [
      "In Gumroad open Settings, then Advanced, and find the Ping endpoint.",
      "Paste the address below as the endpoint. Gumroad sends form fields and cannot send headers, so the token is part of the address.",
    ],
    token: "address",
    confidence: "partly",
    note: "Gumroad sends the price in US cents, and every field arrives as text.",
    form: {
      eventMode: "fixed",
      eventValue: "gumroad_sale",
      emailPath: "email",
      traits: [trait("name", "full_name"), trait("gumroad_product_id", "product_id"), trait("gumroad_price_usd_cents", "price")],
    },
    sampleAs: "form",
    sample: { seller_id: "abc", sale_id: "sale_123", product_id: "prod_456", email: "buyer@example.com", full_name: "Buyer Name", price: "1500", subscription_id: "sub_789" },
    expect: { email: "buyer@example.com", event: "gumroad_sale" },
  },
  {
    id: "shopify",
    label: "Shopify",
    group: "Selling",
    summary: "Customers and orders from your Shopify store, each event named by its Shopify topic (customers/create, orders/paid...).",
    steps: [
      "In Shopify open Settings, then Notifications, then Webhooks, then Create webhook. Choose an event and the format JSON.",
      "Paste the address below as the URL. Shopify signs every call, so choose the signature check below and paste the signing secret from your store's webhook settings. If you prefer a token, it goes in the address.",
      "Add a webhook for each event you want in the same Shopify list: they can all use this one source. The topic becomes the event name.",
    ],
    token: "address",
    confidence: "partly",
    note: "Shopify only shares customer data with apps it has approved for it. Customers and orders both carry the email at the top, so both work. A repeated Shopify event id is recorded once.",
    signature: { header: "x-shopify-hmac-sha256", encoding: "base64", secretHint: "The secret Shopify signs your store's webhooks with, shown in the store's webhook settings." },
    form: {
      eventMode: "header",
      eventValue: "X-Shopify-Topic",
      eventIdHeader: "X-Shopify-Event-Id",
      emailPath: "email",
      traits: [trait("first_name", "first_name"), trait("last_name", "last_name"), trait("phone", "phone")],
    },
    sampleAs: "json",
    sampleHeaders: { "x-shopify-topic": "customers/create", "x-shopify-event-id": "b54557e4-bdd9-4b37-8a5f-bf7d70bcd043" },
    sample: { id: 207119551, email: "bob.norman@example.com", first_name: "Bob", last_name: "Norman", phone: "+16135551111", state: "enabled", created_at: "2024-01-01T10:00:00-05:00" },
    expect: { email: "bob.norman@example.com", event: "customers/create" },
  },
  {
    id: "woocommerce",
    label: "WooCommerce customers",
    group: "Selling",
    summary: "A customer is created or updated in your WooCommerce store, named by its WooCommerce topic.",
    steps: [
      "In WordPress open WooCommerce, then Settings, then Advanced, then Webhooks, then Add webhook.",
      "Set the topic to Customer created (or updated) and paste the address below as the delivery URL.",
      "WooCommerce signs every call with the webhook's Secret: choose the signature check below and paste that secret. If you prefer a token, it goes in the address.",
    ],
    token: "address",
    confidence: "partly",
    note: "Customers only: an order carries the email under billing, not at the top, so order webhooks are logged as rejected. A repeated delivery is recorded once.",
    signature: { header: "x-wc-webhook-signature", encoding: "base64", secretHint: "The Secret field of the webhook in WooCommerce." },
    form: {
      eventMode: "header",
      eventValue: "X-WC-Webhook-Topic",
      eventIdHeader: "X-WC-Webhook-Delivery-ID",
      emailPath: "email",
      traits: [trait("first_name", "first_name"), trait("last_name", "last_name")],
    },
    sampleAs: "json",
    sampleHeaders: { "x-wc-webhook-topic": "customer.created", "x-wc-webhook-delivery-id": "d2a1f3b8-0000-4000-8000-000000000042" },
    sample: { id: 25, email: "john.doe@example.com", first_name: "John", last_name: "Doe", role: "customer", username: "john.doe", date_created: "2024-01-01T10:00:00" },
    expect: { email: "john.doe@example.com", event: "customer.created" },
  },
];

/**
 * Presets that are built and tested but not offered in the Type menu yet. Segment is here while it is tested further
 * against a real account. They still run through the same tests as the visible ones. To offer one again, move it back
 * into TOOL_PRESETS and add its group to PRESET_GROUPS.
 */
export const PAUSED_PRESETS: readonly ToolPreset[] = [
  {
    id: "segment",
    label: "Segment",
    group: "Data pipelines",
    summary: "Forward the events Segment already collects, such as track calls.",
    steps: [
      "In Segment add a Webhooks destination to the source whose events you want, and use the address below as its URL. The token is part of the address.",
      "Track calls become events named by their event name. The person is the userId, with the email read from context.traits.email.",
      "Identify calls carry no event name: use a second source for them, with the event set to none and traits read from traits.",
    ],
    token: "address",
    confidence: "docs",
    note: "A repeated Segment messageId is recorded once.",
    form: {
      eventMode: "path",
      eventValue: "event",
      userIdPath: "userId",
      emailPath: "context.traits.email",
      eventIdPath: "messageId",
    },
    sampleAs: "json",
    sample: {
      type: "track",
      event: "Course Clicked",
      userId: "AiUGstSDIg",
      anonymousId: "23adfd82-aa0f-45a7-a756-24f2a7a4c895",
      messageId: "ajs-f8ca1e4de5024d9430b3928bd8ac6b96",
      timestamp: "2015-12-12T19:11:01.249Z",
      properties: { title: "Intro to Analytics" },
      context: { traits: { email: "segment.user@example.com" }, ip: "108.0.78.21" },
    },
    expect: { email: "segment.user@example.com", event: "Course Clicked" },
  },
];

/** The groups shown in the Type menu, in order. (Stripe, which is not a preset, has its own group beside them.) */
export const PRESET_GROUPS: ReadonlyArray<ToolPreset["group"]> = ["Forms and waitlists", "Booking", "Selling"];

export const presetById = (id: string): ToolPreset | undefined => TOOL_PRESETS.find((p) => p.id === id);
