/**
 * Settings hooks: transport, LLM provider, tenant (postal address + brand),
 * business model templates, and test email. Also exports useSetupState, the
 * combined read behind the first-run checklist.
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fetchTransport,
  putTransport,
  fetchLlm,
  putLlm,
  deleteLlm,
  fetchTenant,
  patchTenant,
  sendTestEmail,
  fetchTemplates,
  fetchSending,
  applyTemplate,
  fetchThrottle,
  putThrottle,
  type TransportInput,
  type LlmInput,
  type BrandSettingsData,
  type ThrottleInput,
} from "./api.js";
import { FLOWS_QUERY_KEY } from "./flows.js";

export const TRANSPORT_QUERY_KEY = ["settings", "transport"] as const;
export const LLM_QUERY_KEY = ["settings", "llm"] as const;
export const TENANT_QUERY_KEY = ["settings", "tenant"] as const;
export const TEMPLATES_QUERY_KEY = ["templates"] as const;

export function useTransport() {
  return useQuery({ queryKey: TRANSPORT_QUERY_KEY, queryFn: fetchTransport });
}

export function useLlm() {
  return useQuery({ queryKey: LLM_QUERY_KEY, queryFn: fetchLlm });
}

export function useTenant() {
  return useQuery({ queryKey: TENANT_QUERY_KEY, queryFn: fetchTenant });
}

export function usePutTransport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: TransportInput) => putTransport(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TRANSPORT_QUERY_KEY });
    },
  });
}

export function usePutLlm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LlmInput) => putLlm(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
    },
  });
}

export function usePatchTenant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: { postal_address?: string; brand?: Partial<BrandSettingsData> }) =>
      patchTenant(payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
    },
  });
}

export function useSendTestEmail() {
  return useMutation({
    mutationFn: (to: string) => sendTestEmail(to),
  });
}

export const THROTTLE_QUERY_KEY = ["settings", "throttle"] as const;

export function useThrottle() {
  return useQuery({ queryKey: THROTTLE_QUERY_KEY, queryFn: fetchThrottle });
}

export function usePutThrottle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ThrottleInput) => putThrottle(input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: THROTTLE_QUERY_KEY });
    },
  });
}

export function useTemplates() {
  return useQuery({ queryKey: TEMPLATES_QUERY_KEY, queryFn: fetchTemplates });
}

/** Remove the workspace's own AI key; it then falls back to Mailforge AI. */
export function useDeleteLlm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => deleteLlm(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: LLM_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: ["plan"] });
    },
  });
}

export function useApplyTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => applyTemplate(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: FLOWS_QUERY_KEY });
      void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
    },
  });
}

/**
 * The three reads that define "is this install able to do anything":
 * LLM provider (compilation), transport (sending), postal address
 * (CAN-SPAM, blocks the drain). Used by the first-run checklist and by
 * Settings itself.
 */
export function useSetupState() {
  const [llm, transport, tenant, sending] = useQueries({
    queries: [
      { queryKey: LLM_QUERY_KEY, queryFn: fetchLlm },
      { queryKey: TRANSPORT_QUERY_KEY, queryFn: fetchTransport },
      { queryKey: TENANT_QUERY_KEY, queryFn: fetchTenant },
      // Same key as useSending(): one request serves both.
      { queryKey: ["sending"], queryFn: fetchSending },
    ],
  });

  const isLoading = llm.isLoading || transport.isLoading || tenant.isLoading;
  const isError = llm.isError || transport.isError || tenant.isError;

  const checks = {
    // AI is set up when the workspace has its own key OR Mailforge AI is available to it.
    llm: llm.data !== undefined && (llm.data.llm !== null || (llm.data.ai?.source ?? "none") !== "none"),
    // Email can go out when the workspace connected a provider of its own OR Mailforge Sending is in use.
    transport: (transport.data?.transport !== null && transport.data !== undefined) || sending.data?.uses === "managed",
    postalAddress:
      tenant.data !== undefined && (tenant.data.tenant.postal_address ?? "") !== "",
  };

  return {
    isLoading,
    isError,
    checks,
    complete: checks.llm && checks.transport && checks.postalAddress,
    llm: llm.data?.llm ?? null,
    ai: llm.data?.ai ?? null,
    transport: transport.data?.transport ?? null,
    sending: sending.data ?? null,
    tenant: tenant.data?.tenant ?? null,
  };
}
