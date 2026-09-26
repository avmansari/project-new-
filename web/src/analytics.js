// Privacy-friendly analytics with Plausible (https://plausible.io). No cookies, no personal data.
// Enabled only when VITE_PLAUSIBLE_DOMAIN is set (e.g. "yourapp.com"). Custom events tracked:
//   Wallet connected · Mining started · Block claimed · Order created · Trade · Offer made · Benchmark run
const DOMAIN = import.meta.env.VITE_PLAUSIBLE_DOMAIN || "";
const SRC = import.meta.env.VITE_PLAUSIBLE_SRC || "https://plausible.io/js/script.js";

if (DOMAIN && typeof document !== "undefined") {
  window.plausible ||= function (...args) {
    (window.plausible.q = window.plausible.q || []).push(args);
  };
  const s = document.createElement("script");
  s.defer = true;
  s.dataset.domain = DOMAIN;
  s.src = SRC;
  document.head.appendChild(s);
}

/** Track a custom event (no-op when analytics is off). props: small strings/numbers only, never addresses. */
export function track(name, props) {
  try {
    if (DOMAIN && window.plausible) window.plausible(name, props ? { props } : undefined);
  } catch {}
}

export const analyticsUrl = () => (DOMAIN ? `https://plausible.io/${DOMAIN}` : null);
