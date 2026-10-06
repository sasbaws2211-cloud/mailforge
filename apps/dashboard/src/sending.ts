/**
 * Managed sending (Mailforge sends your email for you): hooks, and the pure rules the
 * screen uses to decide what to say about the sender, the domain and its DNS records.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteSending,
  deleteSendingDomain,
  enableSending,
  fetchSending,
  patchSending,
  putSendingDomain,
  verifySendingDomain,
  type SendingDnsRecord,
  type SendingView,
} from "./api.js";
import type { BadgeVariant } from "./components/ui/badge.js";

export const SENDING_QUERY_KEY = ["sending"] as const;

/** Where a domain stands: still being set up (poll while it is), done, or needing attention. */
export function domainIsSettling(status: string | undefined): boolean {
  return status === "not_started" || status === "pending" || status === "temporary_failure";
}

/** GET /v1/sending, re-read every 15 seconds while a domain is being verified so it turns green on its own. */
export function useSending() {
  return useQuery({
    queryKey: SENDING_QUERY_KEY,
    queryFn: fetchSending,
    staleTime: 10_000,
    refetchInterval: (q) => (domainIsSettling(q.state.data?.managed?.domain_status) ? 15_000 : false),
  });
}

/** Run one change to managed sending, then refresh it and everything that depends on whether mail can be sent. */
export function useSendingChange<TArgs = void>(fn: (a: TArgs) => Promise<SendingView>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (view) => {
      qc.setQueryData(SENDING_QUERY_KEY, view);
      void qc.invalidateQueries({ queryKey: ["settings", "transport"] });
    },
  });
}

export const sendingApi = {
  enable: enableSending,
  disable: deleteSending,
  patch: patchSending,
  setDomain: putSendingDomain,
  verify: verifySendingDomain,
  removeDomain: deleteSendingDomain,
};

export interface DomainStatusInfo {
  label: string;
  variant: BadgeVariant;
  /** One plain sentence on what it means and what to do. */
  help: string;
}

export function domainStatusInfo(status: string): DomainStatusInfo {
  switch (status) {
    case "verified":
      return { label: "Verified", variant: "success", help: "Your domain is verified. Email now goes out from your own address." };
    case "pending":
      return { label: "Checking", variant: "accent", help: "We are checking your DNS records. This usually takes a few minutes, but can take up to a day." };
    case "not_started":
      return { label: "Waiting for DNS records", variant: "warning", help: "Add the records below at your DNS provider, then press Check now." };
    case "temporary_failure":
      return { label: "Still checking", variant: "warning", help: "We could not confirm the records yet. We will keep trying. If you have just added them, give it a little while." };
    case "failed":
      return { label: "Not verified", variant: "danger", help: "We could not find the records. Check that each one is added exactly as shown (a common slip is the DNS provider adding your domain name again at the end), then press Check now." };
    default:
      return { label: "Not set up", variant: "muted", help: "" };
  }
}

/** The host name to create at the DNS provider: Resend gives it relative to the domain; this is the full name too. */
export function recordFullName(record: Pick<SendingDnsRecord, "name">, domain: string): string {
  const n = record.name.trim();
  if (n === "" || n === "@") return domain;
  return n.endsWith(`.${domain}`) || n === domain ? n : `${n}.${domain}`;
}

/** What each record is for, in plain words. */
export function recordPurpose(record: Pick<SendingDnsRecord, "record" | "type">): string {
  const r = record.record.toUpperCase();
  if (r === "DKIM") return "Proves your email really comes from you";
  if (r === "SPF" && record.type.toUpperCase() === "MX") return "Lets bounces find their way back";
  if (r === "SPF") return "Says which service may send for your domain";
  if (r === "DMARC") return "Tells inboxes how to treat suspicious mail";
  return "Needed to verify your domain";
}

export interface SenderSummary {
  /** Short headline for the top of the card. */
  headline: string;
  /** Sentences under it. */
  detail: string;
  tone: "success" | "warning" | "info";
}

/** What to tell the owner about how their mail goes out right now. */
export function describeSender(v: SendingView): SenderSummary {
  if (!v.available) return { headline: "Not available", detail: "This service does not include email sending. Connect your own email provider below.", tone: "info" };
  const m = v.managed;
  if (v.uses === "own_transport") {
    return {
      headline: "You are using your own email provider",
      detail: "Mailforge Sending is on standby. Remove your own provider below if you want Mailforge to send for you instead.",
      tone: "info",
    };
  }
  if (!m || !m.enabled) {
    return { headline: "Mailforge Sending is off", detail: "Turn it on and Mailforge sends your email for you. There is nothing to connect.", tone: "info" };
  }
  if (m.paused) {
    return {
      headline: "Sending is paused",
      detail: `${m.paused.automatic ? "We paused it automatically because of how recent emails performed. " : ""}${m.paused.reason ? `${m.paused.reason}. ` : ""}Your emails are safe and will send once it resumes. Contact support to get going again.`,
      tone: "warning",
    };
  }
  if (!m.sender) {
    return {
      headline: "Add your domain to start sending",
      detail: "There is no shared sending address on this service, so you need to verify a domain of your own before email can go out.",
      tone: "warning",
    };
  }
  if (m.sender.mode === "domain") {
    return { headline: "Sending from your own domain", detail: `Email goes out as ${m.sender.from_name} <${m.sender.from_email}>. Replies go to ${m.sender.reply_to ?? "your account email"}.`, tone: "success" };
  }
  const cap = v.shared.daily_limit;
  return {
    headline: "Sending from a shared Mailforge address",
    detail:
      `Email goes out as ${m.sender.from_name}, replies go to ${m.sender.reply_to ?? "your account email"}.` +
      (cap ? ` Up to ${cap.toLocaleString("en-US")} emails a day this way.` : "") +
      " Add your own domain for more volume and better delivery.",
    tone: "info",
  };
}

/** Can mail actually go out through Mailforge Sending right now? */
export function sendingIsActive(v: SendingView | undefined): boolean {
  return v?.uses === "managed";
}
