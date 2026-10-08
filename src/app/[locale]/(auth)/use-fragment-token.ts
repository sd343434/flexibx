"use client";

import { useEffect, useState } from "react";

/**
 * The single-use token of an email link, read from the URL fragment (`#token=…`).
 * Browsers never send the fragment to the server, so the token stays out of request
 * logs, proxies and Referer headers. Once read, it is removed from the address bar and
 * history. `ready` is false until the browser has been checked (first render).
 */
export function useFragmentToken(): { readonly ready: boolean; readonly token: string | null } {
  const [state, setState] = useState<{ ready: boolean; token: string | null }>({
    ready: false,
    token: null,
  });
  useEffect(() => {
    const read = () => {
      const token = new URLSearchParams(window.location.hash.slice(1)).get("token");
      if (window.location.hash !== "") {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      setState((previous) =>
        // A later hash change without a token keeps the token already read.
        token === null || token === ""
          ? { ready: true, token: previous.token }
          : { ready: true, token },
      );
    };
    read();
    // A link opened while this page is already showing only changes the fragment.
    window.addEventListener("hashchange", read);
    return () => {
      window.removeEventListener("hashchange", read);
    };
  }, []);
  return state;
}
