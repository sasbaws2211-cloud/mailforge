"use client";
/**
 * React (and Next.js) helpers: <LoomailProvider> and useLoomail().
 *
 *   <LoomailProvider publishableKey="mf_pub_..." endpoint="https://loomail.example.com" autoPage user={user && { id: user.id, traits: { email: user.email } }}>
 *     <App />
 *   </LoomailProvider>
 *
 *   const loomail = useLoomail();
 *   loomail.track("clicked_upgrade");
 *
 * Works in the Next.js app router (this file is a client module), the pages router, Vite and Create React App. Route
 * changes are followed through the History API, which every client-side router uses, so no router-specific code is needed.
 * Rendering on the server does nothing; the client starts after mount.
 *
 * Mirror side: PUBLIC (packages/sdk-browser is mirrored).
 */
import { createContext, createElement, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { createLoomail, createNoopClient, type LoomailClient, type LoomailOptions, type Traits } from "./client.js";

const Context = createContext<LoomailClient | null>(null);

export interface LoomailProviderProps extends Omit<LoomailOptions, "key" | "autoStart"> {
  /** Publishable key (mf_pub_...). */
  publishableKey: string;
  /**
   * Who is signed in. Give { id, traits? } when someone is signed in and null when nobody is; the provider identifies
   * them (once per id and traits), and resets when it goes from a person to null (logout). Leave it out to call
   * identify() and reset() yourself.
   */
  user?: { id: string; traits?: Traits } | null;
  /** Use a client you made yourself instead of creating one. */
  client?: LoomailClient;
  children?: ReactNode;
}

export function LoomailProvider(props: LoomailProviderProps): ReactNode {
  const { publishableKey, user, client: given, children, ...options } = props;
  // One client for the life of the provider; changing the key or address needs a new provider (use `key` on it).
  const [client] = useState<LoomailClient>(() => given ?? createLoomail({ ...options, key: publishableKey, autoStart: false }));

  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);

  const identified = useRef<{ id: string; traits: string } | null>(null);
  const userId = user === undefined ? undefined : user === null ? null : user.id;
  const traitsJson = user ? JSON.stringify(user.traits ?? {}) : "";
  useEffect(() => {
    if (userId === undefined) return;
    if (userId === null) {
      if (identified.current) {
        client.reset();
        identified.current = null;
      }
      return;
    }
    if (identified.current && identified.current.id === userId && identified.current.traits === traitsJson) return;
    client.identify(userId, JSON.parse(traitsJson) as Traits);
    identified.current = { id: userId, traits: traitsJson };
  }, [client, userId, traitsJson]);

  return createElement(Context.Provider, { value: client }, children);
}

let warned = false;

/** The client. Outside a <LoomailProvider> it does nothing (and says so once in development) instead of crashing the page. */
export function useLoomail(): LoomailClient {
  const client = useContext(Context);
  const fallback = useRef<LoomailClient | null>(null);
  if (client) return client;
  if (!warned && typeof console !== "undefined") {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn("[loomail] useLoomail() was used outside <LoomailProvider>. Nothing will be sent.");
  }
  return (fallback.current ??= createNoopClient());
}
