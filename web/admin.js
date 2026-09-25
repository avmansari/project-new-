(() => {
  "use strict";
  const main = document.getElementById("main");
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "onclick") n.addEventListener("click", v);
      else if (k === "style") n.style.cssText = v;
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid) n.append(kid);
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  const show = (...kids) => { clear(main); main.append(...kids.flat().filter(Boolean)); };

  async function api(path, opts) {
    const r = await fetch(path, { ...opts, credentials: "same-origin" });
    let data = null;
    try { data = await r.json(); } catch { /* no body */ }
    if (r.status === 401) { renderLogin(); throw new Error("Session khatam ho gayi, dobara login karo."); }
    if (!r.ok) throw new Error((data && data.error && data.error.message) || `Error ${r.status}`);
    return data;
  }
  const postJson = (path, body) => api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

  function renderLogin(msg) {
    const pw = el("input", { type: "password", placeholder: "Admin password", autocomplete: "current-password" });
    const err = el("div", { class: "err", text: msg || "" });
    const btn = el("button", { class: "btn", type: "submit", text: "Login" });
    const form = el("form", { class: "card", style: "max-width:340px" }, el("label", { text: "Password" }), pw, el("div", { style: "margin-top:12px" }, btn), err);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try {
        await postJson("/api/admin/login", { password: pw.value });
        renderOps();
      } catch (ex) { err.textContent = ex.message; }
      btn.disabled = false;
    });
    show(el("h1", { text: "Admin Login" }), form);
  }

  function tabs(active) {
    const t = el("div", { class: "tabs" },
      el("a", { class: "tab" + (active === "ops" ? " active" : ""), href: "#ops", text: "Operations" }),
      el("a", { class: "tab" + (active === "pending" ? " active" : ""), href: "#pending", text: "Pending Review" }),
      el("a", { class: "tab" + (active === "collections" ? " active" : ""), href: "#collections", text: "Live Collections" }),
      el("a", { class: "tab" + (active === "all" ? " active" : ""), href: "#all", text: "All Submissions" }));
    t.children[0].addEventListener("click", (e) => { e.preventDefault(); renderOps(); });
    t.children[1].addEventListener("click", (e) => { e.preventDefault(); renderPending(); });
    t.children[2].addEventListener("click", (e) => { e.preventDefault(); renderCollections(); });
    t.children[3].addEventListener("click", (e) => { e.preventDefault(); renderAll(); });
    const logout = el("button", { class: "btn ghost", type: "button", text: "Logout" });
    logout.addEventListener("click", async () => { await postJson("/api/admin/logout"); renderLogin(); });
    return el("div", { class: "row" }, t, logout);
  }

  function zec(zats) {
    const s = String(zats || "0");
    return (Number(s) / 100000000).toLocaleString(undefined, { maximumFractionDigits: 8 }) + " ZEC";
  }

  async function renderOps() {
    show(el("div", { class: "eyebrow", text: "Operations / treasury" }), el("h1", { text: "Payment control center" }), tabs("ops"), el("p", { class: "dim", text: "Live payment queue, confirming orders, creator payouts and review signals." }));
    try {
      const { stats, payments } = await api("/api/admin/stats");
      const cards = el("div", { class: "stat-strip" },
        el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Pending payments" }), el("strong", { text: String(stats.awaiting) })),
        el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Confirming now" }), el("strong", { text: String(stats.confirming) })),
        el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Pending payouts" }), el("strong", { text: zec(stats.payoutAmountZats) })),
        el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Failed / review" }), el("strong", { text: String(stats.review) })));
      const rows = el("div", {});
      if (!payments.length) rows.append(el("div", { class: "empty-state card" }, el("h3", { text: "No active payment queue" }), el("p", { class: "dim", text: "New mint and marketplace orders will appear here." })));
      for (const p of payments) {
        const status = p.funded ? "Confirming" : p.status === "paid" ? "Minting" : p.status === "refund_needed" ? "Review" : "Pending";
        rows.append(el("div", { class: "activity-row card" }, el("strong", { class: "mono", text: "#" + p.id }), el("div", {}, el("strong", { text: p.collectionName }), el("div", { class: "dim", text: zec(p.amountZats) + " · " + (p.confirmations || 0) + " confirmations" })), el("span", { class: "badge " + (status === "Review" ? "warn" : status === "Confirming" ? "live" : ""), text: status })));
      }
      show(el("div", { class: "eyebrow", text: "Operations / treasury" }), el("h1", { text: "Payment control center" }), tabs("ops"), el("p", { class: "lead", text: "Monitor pending payments, failed transactions, refunds and creator payouts from one admin workspace." }), cards, el("div", { class: "section-heading" }, el("h2", { text: "Payment queue" }), el("span", { class: "dim", text: payments.length + " active orders" })), rows);
    } catch (ex) { show(el("h1", { text: "Admin" }), tabs("ops"), el("div", { class: "msg bad", text: ex.message })); }
  }

  async function renderAll() {
    show(el("h1", { text: "Admin" }), tabs("all"), el("p", { class: "dim", text: "Loading..." }));
    let items;
    try { items = (await api("/api/admin/all")).items; } catch (ex) { show(el("h1", { text: "Admin" }), tabs("all"), el("div", { class: "msg bad", text: ex.message })); return; }
    const STATUS_LABEL = { pending_review: "Pending Review", live: "Live", ended: "Ended", cancelled: "Rejected/Cancelled" };
    const list = el("div", {});
    if (!items.length) list.append(el("p", { class: "dim", text: "Abhi koi submission nahi." }));
    for (const it of items) {
      list.append(el("div", { class: "card" },
        el("div", { class: "row" }, el("h3", { text: it.name }), el("span", { class: "badge " + (it.status === "live" ? "live" : it.status === "cancelled" ? "warn" : ""), text: STATUS_LABEL[it.status] || it.status })),
        el("div", { class: "dim mono", text: it.slug }),
        el("div", { class: "dim", text: it.supply + " images  |  creator: " + (it.creatorAddress || "-") + "  |  submitted: " + (it.submittedAt ? new Date(it.submittedAt).toLocaleString() : "-") }),
        it.startsAt ? el("div", { class: "dim", text: "Scheduled launch: " + new Date(it.startsAt).toLocaleString() }) : null,
        it.rejectReason ? el("div", { class: "dim", text: "Reject reason: " + it.rejectReason }) : null));
    }
    show(el("h1", { text: "Admin" }), tabs("all"), list);
  }

  async function renderPending() {
    show(el("h1", { text: "Admin" }), tabs("pending"), el("p", { class: "dim", text: "Loading..." }));
    let items;
    try { items = (await api("/api/admin/pending")).items; } catch (ex) { show(el("h1", { text: "Admin" }), tabs("pending"), el("div", { class: "msg bad", text: ex.message })); return; }
    const list = el("div", {});
    if (!items.length) list.append(el("p", { class: "dim", text: "Koi pending submission nahi." }));
    for (const it of items) {
      const preview = el("div", { class: "grid" });
      api(`/api/admin/collections/${it.slug}/preview`).then((p) => {
        for (const n of p.tokenNumbers.slice(0, 6)) {
          preview.append(el("img", { src: `/api/admin/collections/${it.slug}/image?n=${n}`, class: "art", style: "max-width:90px" }));
        }
      }).catch(() => {});
      const reasonBox = el("input", { type: "text", placeholder: "Reject reason" });
      const approveBtn = el("button", { class: "btn", type: "button", text: "Approve" });
      const rejectBtn = el("button", { class: "btn ghost", type: "button", text: "Reject" });
      const err = el("div", { class: "err" });
      approveBtn.addEventListener("click", async () => {
        approveBtn.disabled = true;
        try { await postJson("/api/admin/approve", { slug: it.slug }); renderPending(); } catch (ex) { err.textContent = ex.message; approveBtn.disabled = false; }
      });
      rejectBtn.addEventListener("click", async () => {
        if (!reasonBox.value.trim()) { err.textContent = "Reject reason likho"; return; }
        rejectBtn.disabled = true;
        try { await postJson("/api/admin/reject", { slug: it.slug, reason: reasonBox.value.trim() }); renderPending(); } catch (ex) { err.textContent = ex.message; rejectBtn.disabled = false; }
      });
      list.append(el("div", { class: "card" },
        el("div", { class: "row" }, el("h3", { text: it.name }), el("span", { class: "dim mono", text: it.slug })),
        el("div", { class: "dim", text: it.supply + " images  |  creator: " + (it.creatorAddress || "-") + "  |  submitted: " + (it.submittedAt ? new Date(it.submittedAt).toLocaleString() : "-") }),
        el("div", { style: "margin:10px 0" }, preview),
        el("div", { class: "row" }, approveBtn, el("div", {}, reasonBox, " ", rejectBtn)),
        err));
    }
    show(el("h1", { text: "Admin" }), tabs("pending"), list);
  }

  async function renderCollections() {
    show(el("h1", { text: "Admin" }), tabs("collections"), el("p", { class: "dim", text: "Loading..." }));
    let items;
    try { items = (await api("/api/admin/collections")).items; } catch (ex) { show(el("h1", { text: "Admin" }), tabs("collections"), el("div", { class: "msg bad", text: ex.message })); return; }
    const list = el("div", {});
    for (const it of items) {
      const err = el("div", { class: "err" });
      const reasonBox = el("input", { type: "text", placeholder: "Freeze reason" });
      const freezeBtn = el("button", { class: "btn ghost", type: "button", text: it.frozen ? "Unfreeze" : "Freeze" });
      freezeBtn.addEventListener("click", async () => {
        freezeBtn.disabled = true;
        try {
          if (it.frozen) await postJson("/api/admin/unfreeze", { slug: it.slug });
          else {
            if (!reasonBox.value.trim()) { err.textContent = "Freeze reason likho"; freezeBtn.disabled = false; return; }
            await postJson("/api/admin/freeze", { slug: it.slug, reason: reasonBox.value.trim() });
          }
          renderCollections();
        } catch (ex) { err.textContent = ex.message; freezeBtn.disabled = false; }
      });
      list.append(el("div", { class: "card" },
        el("div", { class: "row" },
          el("h3", {}, it.name, it.frozen ? el("span", { class: "badge warn", text: " FROZEN" }) : null),
          el("span", { class: "dim mono", text: it.slug })),
        it.frozen ? el("div", { class: "dim", text: "Reason: " + (it.frozenReason || "-") }) : null,
        el("div", { class: "row", style: "margin-top:10px" }, it.frozen ? null : reasonBox, freezeBtn),
        err));
    }
    show(el("h1", { text: "Admin" }), tabs("collections"), list);
  }

  api("/api/admin/stats").then(() => renderOps()).catch(() => renderLogin());
})();
