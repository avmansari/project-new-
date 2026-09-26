// First visit to the app: short terms & risk summary; the user must tick + click "I agree" to continue.
// Acceptance is remembered per browser; bump TERMS_VERSION when terms.html changes to ask again.
const TERMS_VERSION = "1";
const KEY = "pow-terms-accepted";

function accepted() {
  try {
    return localStorage.getItem(KEY) === TERMS_VERSION;
  } catch {
    return false;
  }
}

export function requireTerms() {
  if (accepted()) return;
  const overlay = document.createElement("div");
  overlay.className = "modal terms-modal";
  overlay.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="termsTitle">
      <h2 id="termsTitle">Before you start</h2>
      <ul class="small">
        <li>This is experimental software on a public blockchain. <b>Not financial advice.</b></li>
        <li>Tokens may lose all value. Smart contracts can have bugs. Only use funds you can afford to lose.</li>
        <li>Claiming a block costs ~$0.10 in ETH + gas; marketplace trades have a 2% fee.</li>
        <li>You're responsible for your wallet, your taxes, and following your local laws. You must be 18+.</li>
        <li>Not affiliated with Robinhood Markets, Inc.</li>
      </ul>
      <label class="agree"><input type="checkbox" id="termsCheck" /> I have read and agree to the <a href="/terms.html" target="_blank" rel="noopener">Terms &amp; risk disclaimer</a></label>
      <button id="termsAgree" disabled>I agree</button>
    </div>`;
  document.body.appendChild(overlay);
  document.body.classList.add("locked");
  const check = overlay.querySelector("#termsCheck");
  const btn = overlay.querySelector("#termsAgree");
  check.onchange = () => (btn.disabled = !check.checked);
  btn.onclick = () => {
    try {
      localStorage.setItem(KEY, TERMS_VERSION);
    } catch {}
    overlay.remove();
    document.body.classList.remove("locked");
  };
}
