import { explainError, fmtZec, mintWithWallet, sendPayment } from "/noir.js";
import { connectWallet, disconnectWallet, getConnectedAddress, getNoirProvider, onWalletChange, short, tryReconnect } from "/wallet-state.js";

{
  // Saara data textContent se dikhta hai (HTML string se kabhi nahi) => koi bhi input page mein code nahi chala sakta.
  const main = document.getElementById("main");
  const qs = new URLSearchParams(location.search);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k === "style") n.style.cssText = v; // CSSOM se (CSP inline style attribute rokta hai)
      else if (k === "onclick") n.addEventListener("click", v);
      else if (v !== undefined && v !== null) n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid) n.append(kid);
    return n;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); };
  const show = (...kids) => { clear(main); main.append(...kids.flat().filter(Boolean)); };

  async function api(path, opts) {
    let r;
    try { r = await fetch(path, opts); } catch { throw new Error("Server se connect nahi ho paya"); }
    let data = null;
    try { data = await r.json(); } catch { /* json nahi */ }
    if (!r.ok) throw new Error((data && data.error && data.error.message) || `Error ${r.status}`);
    return data;
  }

  // Image URL sirf hamare apne server ke rasta ho sakte hain (koi bahari URL nahi)
  function safeSrc(u) { return typeof u === "string" && (u === "/placeholder.svg" || /^\/api\/collections\/[a-z0-9-]+\/(cover|profile|banner|tokens\/\d+\/image)(\?thumb=1)?$/.test(u)) ? u : "/placeholder.svg"; }
  function picture(url, alt, cls) {
    return el("img", { class: cls || "art", src: safeSrc(url), alt: alt || "", loading: "lazy", decoding: "async" });
  }
  // Banner na ho to PFP/cover ka blur kiya hua backdrop dikhao (khaali gradient se behtar); dono na hon to gradient.
  function bannerOrFallback(c, cls) {
    if (c.bannerUrl) return picture(c.bannerUrl, c.name + " banner", cls);
    const src = c.profileUrl || c.coverUrl;
    if (!src) return el("div", { class: cls + " collection-banner-placeholder" });
    return el("div", { class: cls + " collection-banner-placeholder banner-fallback" }, picture(src, "", "banner-fallback-art"));
  }
  function collectionCardArtwork(c, link) {
    return el("a", { class: "collection-card-artwork", href: link },
      bannerOrFallback(c, "collection-card-banner"),
      picture(c.profileUrl || c.coverUrl, c.name + " profile", "collection-card-avatar"));
  }
  function notStarted(c) { return c.startsAt && new Date(c.startsAt) > new Date(); }
  function countdownLabel(iso) {
    const ms = new Date(iso) - new Date();
    if (ms <= 0) return "Launch ho chuka hai";
    const mins = Math.floor(ms / 60000), h = Math.floor(mins / 60), d = Math.floor(h / 24);
    if (d > 0) return "Launch me " + d + "d " + (h % 24) + "h";
    if (h > 0) return "Launch me " + h + "h " + (mins % 60) + "m";
    return "Launch me " + Math.max(1, mins) + "m";
  }

  function nftCard(item) {
    return el("a", { class: "nft", href: "/token.html?c=" + encodeURIComponent(item.collection) + "&n=" + item.tokenNumber },
      picture(item.thumbUrl || item.imageUrl, item.name), el("div", { class: "nm", text: item.name }),
      el("div", { class: "dim", text: item.collectionName + " #" + item.tokenNumber + (item.revealed === false ? "  (hidden until reveal)" : "") }));
  }

  const recent = {
    get() { try { return JSON.parse(localStorage.getItem("recentOrders") || "[]"); } catch { return []; } },
    add(o) { try { const l = [o, ...this.get().filter((x) => x.id !== o.id)].slice(0, 10); localStorage.setItem("recentOrders", JSON.stringify(l)); } catch { /* ignore */ } },
  };

  function copyBtn(text, label) {
    const b = el("button", { class: "btn ghost", type: "button", text: label });
    b.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; setTimeout(() => (b.textContent = label), 1200); }
      catch { b.textContent = "Copy nahi hua"; }
    });
    return b;
  }

  // ---------------- pages ----------------
  async function pageIndex() {
    const sort = qs.get("sort") === "trending" ? "trending" : "new";
    const q = qs.get("q") || "";
    const qsPart = (q ? "q=" + encodeURIComponent(q) + "&" : "") + (sort === "trending" ? "sort=trending" : "");
    const [{ collections }] = await Promise.all([api("/api/collections" + (qsPart ? "?" + qsPart.replace(/&$/, "") : ""))]);
    const search = el("input", { type: "search", placeholder: "Collections khojo...", value: q });
    const searchForm = el("form", { class: "search" }, search, el("button", { class: "btn ghost", type: "submit", text: "Search" }));
    searchForm.addEventListener("submit", (e) => { e.preventDefault(); location.href = "/?" + (search.value.trim() ? "q=" + encodeURIComponent(search.value.trim()) : "") + (sort === "trending" ? "&sort=trending" : ""); });
    const tabs = el("div", { class: "tabs" },
      el("a", { class: "tab" + (sort === "new" ? " active" : ""), href: "/" + (q ? "?q=" + encodeURIComponent(q) : ""), text: "New" }),
      el("a", { class: "tab" + (sort === "trending" ? " active" : ""), href: "/?sort=trending" + (q ? "&q=" + encodeURIComponent(q) : ""), text: "Trending (7d)" }));
    const grid = el("div", { class: "grid" });
    if (!collections.length) grid.append(el("p", { class: "dim", text: "Abhi koi live collection nahi hai." }));
    for (const c of collections) {
      const pct = c.supply ? Math.round((c.minted / c.supply) * 100) : 0;
      const status = c.frozen ? "Frozen" : c.status === "live" ? "Live" : "Ended";
      const canMint = c.status === "live" && !c.frozen && c.available > 0 && !notStarted(c);
      const link = "/collection.html?c=" + encodeURIComponent(c.slug);
      grid.append(
        el("div", { class: "card" },
          collectionCardArtwork(c, link),
          el("div", { class: "row" }, el("h3", {}, el("a", { href: link, text: c.name }), c.verified ? el("span", { class: "verified", title: "Verified: 20+ ZEC volume", text: " ✓" }) : null), el("span", { class: "badge " + (c.frozen ? "warn" : c.status === "live" ? "live" : ""), text: status })),
          el("div", { class: "row" }, el("span", { class: "dim", text: "Price" }), el("span", {}, c.priceZec + " ZEC", c.priceUsd ? el("span", { class: "dim", text: "  ($" + c.priceUsd + ")" }) : null)),
          c.floorZec ? el("div", { class: "row" }, el("span", { class: "dim", text: "Floor" }), el("span", { text: c.floorZec + " ZEC" })) : null,
          el("div", { class: "row" }, el("span", { class: "dim", text: "Available" }), el("span", { text: c.available + " / " + c.supply })),
          el("div", { class: "bar" }, el("i", { style: "width:" + pct + "%" })),
          el("div", { class: "dim", text: c.minted + " minted  ·  " + c.volumeTotalZec + " ZEC volume" }),
          el("div", { style: "margin-top:12px" },
            notStarted(c) ? el("span", { class: "dim", text: countdownLabel(c.startsAt) }) :
            canMint ? el("a", { class: "btn", href: "/mint.html?c=" + encodeURIComponent(c.slug), text: "Mint" }) : el("span", { class: "dim", text: c.available === 0 ? "Sold out" : "Not available" }))
        )
      );
    }
    const orders = recent.get();
    const box = el("div", { class: "card" });
    if (!orders.length) box.append(el("span", { class: "dim", text: "Aapke recent orders yahan dikhenge." }));
    for (const o of orders) box.append(el("div", { class: "row" }, el("a", { href: "/order.html?id=" + encodeURIComponent(o.id), text: o.name + " x" + o.quantity }), el("span", { class: "dim mono", text: o.id.slice(0, 8) })));
    show(el("h1", { text: "Launchpad" }), el("p", { class: "dim", text: "Fully automated Zcash NFT marketplace. Connect your wallet, approve the exact amount, and let the chain handle the rest." }), searchForm, tabs, grid, el("h2", { text: "Your recent orders" }), box);
  }

  async function pageCollection() {
    const slug = qs.get("c") || "";
    const { collection: c } = await api("/api/collections/" + encodeURIComponent(slug));
    const gallery = el("div", { class: "grid nfts" });
    const more = el("button", { class: "btn ghost", type: "button", text: "Load more" });
    let offset = 0, total = 0;
    async function load() {
      more.disabled = true;
      const g = await api("/api/collections/" + encodeURIComponent(slug) + "/gallery?limit=24&offset=" + offset);
      total = g.total;
      for (const it of g.items) gallery.append(nftCard(it));
      offset += g.items.length;
      more.hidden = offset >= total;
      more.disabled = false;
      if (total === 0) gallery.append(el("p", { class: "dim", text: "Abhi koi NFT mint nahi hua." }));
    }
    const forSale = el("div", { class: "grid nfts" });
    async function loadForSale() {
      const g = await api("/api/marketplace/listings?collection=" + encodeURIComponent(slug) + "&limit=24");
      if (!g.items.length) { forSale.append(el("p", { class: "dim", text: "Is collection ki koi NFT abhi bikri ke liye list nahi hai." })); return; }
      for (const it of g.items) {
        forSale.append(el("a", { class: "nft", href: "/token.html?c=" + encodeURIComponent(slug) + "&n=" + it.tokenNumber },
          picture(it.thumbUrl || it.imageUrl, c.name + " #" + it.tokenNumber), el("div", { class: "nm", text: c.name + " #" + it.tokenNumber }),
          el("div", { class: "dim", text: it.priceZec + " ZEC" })));
      }
    }
    const canMint = c.status === "live" && !c.frozen && c.available > 0 && !notStarted(c);
    show(
      el("section", { class: "collection-profile" },
        bannerOrFallback(c, "collection-banner-image"),
        el("div", { class: "collection-identity" },
          picture(c.profileUrl || c.coverUrl, c.name + " profile", "collection-avatar"),
          el("div", { class: "collection-identity-copy" },
            el("div", { class: "eyebrow", text: "Collection" }),
            el("h1", {}, c.name, c.verified ? el("span", { class: "verified", title: "Verified: 20+ ZEC volume", text: " \u2713" }) : null),
            el("p", { class: "dim", text: c.priceZec + " ZEC each  ·  " + c.minted + " minted  ·  " + c.available + " of " + c.supply + " available" }))),
        el("div", { class: "collection-profile-details" },
          c.description ? el("p", { class: "lead", text: c.description }) : null,
          c.websiteUrl || c.xUrl ? el("div", { class: "social-links" }, c.websiteUrl ? el("a", { class: "btn ghost", href: c.websiteUrl, target: "_blank", rel: "noreferrer", text: "Website ↗" }) : null, c.xUrl ? el("a", { class: "btn ghost", href: c.xUrl, target: "_blank", rel: "noreferrer", text: "X ↗" }) : null) : null,
          c.floorZec ? el("p", { class: "dim", text: "Floor: " + c.floorZec + " ZEC  |  " + c.listingCount + " for sale  |  " + c.volumeTotalZec + " ZEC total volume" }) : null,
          notStarted(c) ? el("div", { class: "msg", text: countdownLabel(c.startsAt) + " (" + new Date(c.startsAt).toLocaleString() + ")" }) : null,
          c.revealMode === "after_soldout" && !c.revealed ? el("div", { class: "msg", text: "Art sold out hone ke baad reveal hoga." }) : null,
          canMint ? el("a", { class: "btn", href: "/mint.html?c=" + encodeURIComponent(c.slug), text: "Mint" }) : el("span", { class: "dim", text: c.available === 0 ? "Sold out" : "Mint abhi band hai" }),
          c.provenanceHash ? el("p", { class: "dim provenance" }, "Provenance hash: ", el("span", { class: "mono", text: c.provenanceHash })) : null)),
      el("h2", { text: "For Sale" }), forSale,
      el("h2", { text: "Minted NFTs" }), gallery, el("div", { style: "margin-top:14px" }, more));
    more.addEventListener("click", () => load().catch((e) => { more.disabled = false; alert(e.message); }));
    await Promise.all([load(), loadForSale()]);
  }

  async function pageToken() {
    const slug = qs.get("c") || "", n = qs.get("n") || "";
    const { token: t } = await api("/api/collections/" + encodeURIComponent(slug) + "/tokens/" + encodeURIComponent(n));
    const traits = el("div", { class: "grid" });
    for (const a of t.attributes) traits.append(el("div", { class: "card" }, el("div", { class: "dim", text: String(a.trait_type) }), el("div", { text: String(a.value) })));

    const err = el("div", { class: "err" });
    const mkt = el("div", { class: "card" });
    async function buyWithWallet(listing, btn) {
      err.textContent = ""; btn.disabled = true;
      try {
        const provider = await getNoirProvider();
        if (!provider) throw new Error("Noir Wallet nahi mila");
        const buyerAddress = getConnectedAddress();
        const { order } = await api("/api/marketplace/listings/" + listing.id + "/buy", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyerAddress }),
        });
        if (BigInt(order.amountZats) !== BigInt(Math.round(Number(listing.priceZec) * 1e8))) {
          throw new Error("Server ne alag amount bataya, ruk gaye.");
        }
        try {
          await sendPayment(provider, { to: order.payAddress, amount: order.amountZec });
        } catch (payErr) {
          await api("/api/orders/" + encodeURIComponent(order.id) + "/cancel", { method: "POST" }).catch(() => {});
          throw payErr;
        }
        location.href = "/order.html?id=" + encodeURIComponent(order.id);
      } catch (ex) { err.textContent = explainError(ex).message; btn.disabled = false; }
    }

    function drawMarketBox() {
      clear(mkt);
      if (t.blocked) {
        mkt.append(el("div", { class: "msg bad", text: "Ye NFT blocked hai" + (t.blockedReason ? ": " + t.blockedReason : "") + ". Trade nahi ho sakti." }));
        return;
      }
      const connected = getConnectedAddress();
      if (t.listing) {
        if (connected) {
          const btn = el("button", { class: "btn", type: "button", text: "Buy for " + t.listing.priceZec + " ZEC (wallet se)" });
          btn.addEventListener("click", () => buyWithWallet(t.listing, btn));
          mkt.append(el("h3", { text: "For sale: " + t.listing.priceZec + " ZEC" }), el("p", { class: "dim mono", text: "Seller: " + t.listing.sellerAddress }),
            el("p", { class: "dim", text: "Buying to: " + connected }), el("div", { style: "margin-top:10px" }, btn), err);
        } else {
          const buyer = el("input", { type: "text", placeholder: "Aapka address (yahan NFT aayega)", autocomplete: "off", spellcheck: "false" });
          const btn = el("button", { class: "btn", type: "button", text: "Buy for " + t.listing.priceZec + " ZEC" });
          btn.addEventListener("click", async () => {
            err.textContent = ""; btn.disabled = true;
            try {
              const { order } = await api("/api/marketplace/listings/" + t.listing.id + "/buy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyerAddress: buyer.value.trim() }) });
              location.href = "/order.html?id=" + encodeURIComponent(order.id);
            } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
          });
          mkt.append(el("h3", { text: "For sale: " + t.listing.priceZec + " ZEC" }), el("p", { class: "dim mono", text: "Seller: " + t.listing.sellerAddress }),
            el("p", { class: "dim", text: "Wallet connect karo (upar) to address dalna nahi padega." }), buyer, el("div", { style: "margin-top:10px" }, btn), err);
        }
      } else {
        const price = el("input", { type: "text", placeholder: "Price in ZEC (jaise 0.5)", autocomplete: "off" });
        const btn = el("button", { class: "btn", type: "button", text: "List for sale" });
        if (connected) {
          btn.addEventListener("click", async () => {
            err.textContent = ""; btn.disabled = true;
            try {
              await api("/api/marketplace/listings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection: slug, tokenNumber: Number(n), sellerAddress: connected, priceZec: price.value.trim() }) });
              location.reload();
            } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
          });
          mkt.append(el("h3", { text: "List for sale" }), el("p", { class: "dim", text: "Seller: " + connected }), price, el("div", { style: "margin-top:10px" }, btn), err);
        } else {
          const seller = el("input", { type: "text", placeholder: "Aapka address (proof ke taur pe: is address ke paas ye NFT hai)", autocomplete: "off", spellcheck: "false" });
          btn.addEventListener("click", async () => {
            err.textContent = ""; btn.disabled = true;
            try {
              await api("/api/marketplace/listings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection: slug, tokenNumber: Number(n), sellerAddress: seller.value.trim(), priceZec: price.value.trim() }) });
              location.reload();
            } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
          });
          mkt.append(el("h3", { text: "List for sale" }), el("p", { class: "dim", text: "Wallet connect karo (upar) to address dalna nahi padega." }), seller, price, el("div", { style: "margin-top:10px" }, btn), err);
        }
      }
    }
    let unsubMkt = onWalletChange(() => drawMarketBox());
    drawMarketBox();

    // ---- offers ----
    const offersBox = el("div", { class: "card" });
    async function drawOffers() {
      clear(offersBox);
      const connected = getConnectedAddress();
      const isOwner = connected && connected === t.ownerAddress;
      const oerr = el("div", { class: "err" });

      const list = el("div", {});
      if (!t.offers.length) list.append(el("p", { class: "dim", text: "Abhi koi offer nahi." }));
      for (const o of t.offers) {
        const row = el("div", { class: "row" }, el("span", { class: "mono dim", text: o.buyerAddress }), el("span", { text: o.priceZec + " ZEC" }));
        if (isOwner) {
          const acc = el("button", { class: "btn", type: "button", text: "Accept" });
          const rej = el("button", { class: "btn ghost", type: "button", text: "Reject" });
          acc.addEventListener("click", async () => {
            acc.disabled = true; rej.disabled = true;
            try { await api("/api/offers/" + o.id + "/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: connected }) }); location.reload(); }
            catch (ex) { oerr.textContent = ex.message; acc.disabled = false; rej.disabled = false; }
          });
          rej.addEventListener("click", async () => {
            acc.disabled = true; rej.disabled = true;
            try { await api("/api/offers/" + o.id + "/reject", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: connected }) }); location.reload(); }
            catch (ex) { oerr.textContent = ex.message; acc.disabled = false; rej.disabled = false; }
          });
          row.append(acc, rej);
        } else if (connected && connected === o.buyerAddress) {
          const cancel = el("button", { class: "btn ghost", type: "button", text: "Cancel my offer" });
          cancel.addEventListener("click", async () => {
            cancel.disabled = true;
            try { await api("/api/offers/" + o.id + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: connected }) }); location.reload(); }
            catch (ex) { oerr.textContent = ex.message; cancel.disabled = false; }
          });
          row.append(cancel);
        }
        list.append(row);
      }

      const parts = [el("h3", { text: "Offers" }), list];
      if (!isOwner && !t.blocked) {
        const price = el("input", { type: "text", placeholder: "Offer amount (ZEC)", autocomplete: "off" });
        const btn = el("button", { class: "btn", type: "button", text: "Make an offer" });
        btn.addEventListener("click", async () => {
          oerr.textContent = ""; btn.disabled = true; price.disabled = true;
          let created = null;
          try {
            const addr = connected;
            if (!addr) throw new Error("Pehle Noir Wallet connect karo (upar).");
            const provider = await getNoirProvider();
            if (!provider) throw new Error("Noir Wallet nahi mila");
            if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/.test(price.value.trim()) || Number(price.value) <= 0) throw new Error("Offer amount valid ZEC amount hona chahiye.");
            oerr.textContent = "Offer order ban raha hai...";
            const r = await api("/api/offers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection: slug, tokenNumber: Number(n), buyerAddress: addr, priceZec: price.value.trim() }) });
            created = r;
            oerr.textContent = "Wallet mein " + r.amountZec + " ZEC approve karo...";
            await sendPayment(provider, { to: r.payAddress, amount: r.amountZec });
            recent.add({ id: r.offer.id, name: "Offer · " + t.name, quantity: 1 });
            location.href = "/order.html?id=" + encodeURIComponent(r.orderId);
          } catch (ex) {
            if (created?.offer?.id) await api("/api/offers/" + encodeURIComponent(created.offer.id) + "/cancel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: connected }) }).catch(() => {});
            oerr.textContent = explainError(ex).message;
            btn.disabled = false; price.disabled = false;
          }
        });
        parts.push(el("div", { style: "margin-top:10px" }, price, " ", btn));
      }
      parts.push(oerr);
      offersBox.append(...parts);
    }
    let unsubOffers = onWalletChange(() => drawOffers());
    drawOffers();


    const stats = el("div", { class: "stat-strip" },
      el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Token" }), el("strong", { text: "#" + t.tokenNumber })),
      t.rarity ? el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Rarity" }), el("strong", { text: "#" + t.rarity.rank })) : null,
      el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Offers" }), el("strong", { text: String(t.offers.length) })),
      el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Network" }), el("strong", { text: siteNetwork })));
    show(
      el("p", {}, el("a", { href: "/collection.html?c=" + encodeURIComponent(t.collection), text: "← Back to " + t.collectionName })),
      el("div", { class: "hero token-hero" },
        t.imageUrl ? picture(t.imageUrl, t.name, "art big") : el("div", { class: "msg", text: "Is token ki image nahi hai." }),
        el("div", { class: "detail-copy" }, el("div", { class: "eyebrow", text: t.collectionName }), el("h1", { text: t.name }),
          t.revealed ? null : el("div", { class: "msg", text: "Ye NFT sold out ke baad reveal hoga." }),
          t.description ? el("p", { class: "lead", text: t.description }) : el("p", { class: "dim", text: "A collectible secured by the ZAP Market automated ownership flow." }),
          t.listing ? el("div", { class: "price-panel" }, el("span", { class: "dim", text: "Current price" }), el("strong", { text: t.listing.priceZec + " ZEC" }), el("span", { class: "dim", text: "Exact amount opens in your wallet" })) : null,
          mkt, stats)),
      t.attributes.length ? el("h2", { text: "Traits & provenance" }) : null, t.attributes.length ? traits : null,
      t.provenanceHash ? el("div", { class: "card provenance" }, el("span", { class: "dim", text: "Collection provenance" }), el("div", { class: "mono", text: t.provenanceHash })) : null,
      el("h2", { text: "Offers & activity" }), offersBox);
  }

  async function pageMint() {
    const slug = qs.get("c") || "";
    const [{ collection: c }, { network }] = await Promise.all([api("/api/collections/" + encodeURIComponent(slug)), api("/api/config")]);

    if (notStarted(c)) {
      const label = el("div", { class: "dim", text: countdownLabel(c.startsAt) });
      show(
        el("h1", { text: c.name }),
        el("div", { class: "hero" },
          picture(c.coverUrl, c.name, "art cover big"),
          el("div", {},
            el("div", { class: "card" },
              el("h3", { text: "Mint abhi shuru nahi hua" }),
              el("p", { class: "dim", text: c.priceZec + " ZEC each  |  " + c.supply + " supply" }),
              label,
              el("p", { class: "dim", text: "Launch: " + new Date(c.startsAt).toLocaleString() }))))
      );
      setInterval(() => { label.textContent = countdownLabel(c.startsAt); }, 30000);
      return;
    }

    const provider = await getNoirProvider();

    const walletCard = el("div", { class: "card" });
    const err = el("div", { class: "err" });
    const info = el("div", { class: "dim" });

    const qty = el("input", { type: "number", min: "1", max: String(Math.max(1, c.maxPerWallet)), value: "1" });
    const mintBtn = el("button", { class: "btn", type: "button", text: "Mint" });
    const totalZec = () => fmtZec(BigInt(c.priceZats) * BigInt(Math.max(0, Math.floor(Number(qty.value) || 0))));
    const refreshLabel = () => { const q = Math.floor(Number(qty.value) || 0); mintBtn.textContent = q > 0 ? "Mint (" + totalZec() + " ZEC)" : "Mint"; };
    qty.addEventListener("input", refreshLabel);

    function drawWalletCard() {
      clear(walletCard);
      const addr = getConnectedAddress();
      if (addr) {
        walletCard.append(
          el("h3", { text: "Pay with Noir Wallet" }),
          el("div", { class: "dim", text: "Connected: " }), el("div", { class: "mono", text: addr }),
          el("label", { text: "Quantity (max " + c.maxPerWallet + " per wallet)" }), qty,
          el("div", { style: "margin-top:14px" }, mintBtn), info, err);
        refreshLabel();
      } else if (provider) {
        const connectBtn = el("button", { class: "btn", type: "button", text: "Connect Noir Wallet" });
        connectBtn.addEventListener("click", async () => {
          connectBtn.disabled = true; err.textContent = "";
          try { await connectWallet(network); } catch (ex) { err.textContent = explainError(ex).message; }
          connectBtn.disabled = false;
        });
        walletCard.append(el("h3", { text: "Pay with Noir Wallet" }), el("p", { class: "dim", text: "Wallet connect karo, phir Mint dabao. Wallet mein payment ka popup aayega, approve karte hi NFT ka process shuru." }), connectBtn, err);
      } else {
        walletCard.append(el("h3", { text: "Noir Wallet nahi mila" }),
          el("p", { class: "dim", text: "Agar extension install hai to page refresh karo (ya http://localhost:" + (location.port || "3000") + " pe kholo). Nahi hai to neeche wala manual tarika use karo." }));
      }
    }
    onWalletChange(drawWalletCard);
    drawWalletCard();

    mintBtn.addEventListener("click", async () => {
      err.textContent = ""; info.textContent = ""; mintBtn.disabled = true;
      const q = Math.floor(Number(qty.value) || 0);
      if (q < 1 || q > c.maxPerWallet) { err.textContent = "Quantity 1 se " + c.maxPerWallet + " ke beech rakho."; mintBtn.disabled = false; return; }
      try {
        const { order, txid } = await mintWithWallet({
          provider, collection: c, quantity: q, buyerAddress: getConnectedAddress(),
          onStatus: (m) => { info.textContent = m; },
          api: {
            createOrder: async (body) => (await api("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).order,
            cancelOrder: (id) => api("/api/orders/" + encodeURIComponent(id) + "/cancel", { method: "POST" }),
          },
        });
        recent.add({ id: order.id, name: order.collectionName, quantity: order.quantity });
        info.textContent = "Payment submit ho gayi!";
        location.href = "/order.html?id=" + encodeURIComponent(order.id) + "&tx=" + encodeURIComponent(txid);
      } catch (e) {
        info.textContent = "";
        err.textContent = explainError(e).message;
        mintBtn.disabled = false;
      }
    });


    // Manual tarika (kisi bhi wallet se): address daalo, payment address pe khud bhejo
    const addr = el("input", { type: "text", placeholder: "t-address (jahan NFT aayega)", autocomplete: "off", spellcheck: "false" });
    const mQty = el("input", { type: "number", min: "1", max: String(Math.max(1, c.maxPerWallet)), value: "1" });
    const mErr = el("div", { class: "err" });
    const mBtn = el("button", { class: "btn ghost", type: "submit", text: "Create order" });
    const form = el("form", {},
      el("label", { text: "Quantity" }), mQty,
      el("label", { text: "Your address (NFT yahin milega, refund bhi yahin aayega)" }), addr,
      el("div", { style: "margin-top:14px" }, mBtn), mErr);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); mErr.textContent = ""; mBtn.disabled = true;
      try {
        const { order } = await api("/api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ collection: c.slug, quantity: Number(mQty.value), buyerAddress: addr.value.trim() }) });
        recent.add({ id: order.id, name: order.collectionName, quantity: order.quantity });
        location.href = "/order.html?id=" + encodeURIComponent(order.id);
      } catch (ex) { mErr.textContent = ex.message; mBtn.disabled = false; }
    });
    const manual = el("details", { class: "card", style: "margin-top:14px" }, el("summary", { text: "Ya manually pay karo (kisi bhi wallet se)" }), form);

    show(el("div", { class: "hero" }, picture(c.coverUrl, c.name, "art cover big"), el("div", {},
        el("h1", { text: c.name }),
        el("p", { class: "dim", text: c.priceZec + " ZEC each  |  " + c.available + " of " + c.supply + " available" }),
        c.revealMode === "after_soldout" ? el("p", { class: "dim", text: "Art sold out ke baad reveal hoga." }) : null,
        c.frozen ? el("div", { class: "msg bad", text: "Ye collection abhi freeze hai." }) : null)),
      walletCard, manual);
  }

  const STEPS = ["Send the payment", "Payment seen on chain", "Confirming", "NFT minted"];
  function stageIndex(stage) { return { awaiting_payment: 0, payment_seen: 2, minting: 3, done: 4 }[stage] ?? 0; }

  async function pageOrder() {
    const id = qs.get("id") || "";
    let timer = null;
    async function draw() {
      const { order: o } = await api("/api/orders/" + encodeURIComponent(id));
      const idx = stageIndex(o.stage);
      const parts = [el("div", { class: "eyebrow", text: "Automated payment / " + o.id }), el("h1", { text: o.collectionName + " × " + o.quantity }), el("p", { class: "lead", text: "Exact payment, blockchain confirmation and NFT delivery—tracked in one place." })];

      const txParam = /^[0-9a-f]{64}$/i.test(qs.get("tx") || "") ? qs.get("tx") : null;
      if (o.stage === "awaiting_payment" && txParam) {
        parts.push(el("div", { class: "msg", text: "Aapki wallet ne payment bhej di hai. Blockchain pe dikhne mein 1-2 minute lagte hain (yahan page apne aap update hota rahega)." }),
          el("div", { class: "dim mono", text: "tx: " + txParam }));
      } else if (o.stage === "awaiting_payment") {
        const left = Math.max(0, Math.floor((new Date(o.expiresAt) - Date.now()) / 1000));
        parts.push(el("div", { class: "pay" },
          el("div", { class: "dim", text: "Send exactly" }),
          el("div", { class: "big", text: o.amountZec + " ZEC" }),
          el("div", { class: "dim", style: "margin-top:10px", text: "to this address" }),
          el("div", { class: "mono", text: o.payAddress }),
          el("div", { style: "margin-top:10px" }, copyBtn(o.amountZec, "Copy amount"), " ", copyBtn(o.payAddress, "Copy address")),
          el("div", { class: "dim", style: "margin-top:10px", text: "Time left: " + Math.floor(left / 60) + "m " + (left % 60) + "s. Network fee alag se lagti hai, wo amount ke upar se jaani chahiye." })));
      }
      if (["awaiting_payment", "payment_seen", "minting", "done"].includes(o.stage)) {
        parts.push(el("div", { class: "payment-layout" }, el("div", { class: "card payment-summary" }, el("div", { class: "dim", text: "Order amount" }), el("div", { class: "payment-amount", text: o.amountZec + " ZEC" }), el("div", { class: "dim", text: "Quantity: " + o.quantity + " · Network: " + siteNetwork })), el("ul", { class: "steps" }, STEPS.map((s, i) => el("li", { class: i < idx ? "done" : i === idx ? "now" : "", text: s })))));
      }
      if (o.stage === "payment_seen") parts.push(el("div", { class: "msg", text: "Payment mil gayi. Confirmations ka intezaar hai (yahan page apne aap update hota rahega)." }));
      if (o.stage === "minting") parts.push(el("div", { class: "msg", text: "Confirm ho gayi. NFT mint ho raha hai..." }));
      if (o.stage === "done") {
        parts.push(el("div", { class: "msg ok", text: "NFT aapke address pe mint ho gaya." }));
        parts.push(el("div", { class: "grid nfts" }, (o.items || []).map((it) => nftCard(it))));
        parts.push(el("p", {}, el("a", { href: "/wallet.html?address=" + encodeURIComponent(o.buyerAddress), text: "My NFTs dekho" })));
        if (BigInt(o.refundDueZats) > 0n) parts.push(el("div", { class: "msg", text: "Aapne zyada bheja tha. Extra " + o.refundDueZats + " zats wapas kiye jayenge." }));
      }
      if (o.stage === "expired") parts.push(el("div", { class: "msg bad", text: "Ye order expire ho gaya. Agar payment bhej di hai, to wo refund ho jayegi. Warna naya order banao." }));
      if (o.stage === "refund_pending") parts.push(el("div", { class: "msg bad", text: "Aapka paisa wapas kiya jayega (" + o.refundDueZats + " zats). Isme thoda time lag sakta hai." }));
      if (o.stage === "refunded") parts.push(el("div", { class: "msg", text: "Refund bhej diya gaya hai." }));
      show(parts);
      if (["done", "expired", "refunded"].includes(o.stage) && BigInt(o.refundDueZats) === 0n) { clearInterval(timer); timer = null; }
    }
    await draw();
    timer = setInterval(() => draw().catch(() => {}), 5000);
  }

  async function pageWallet() {
    let unsub = null;
    unsub = onWalletChange(() => { if (unsub) unsub(); pageWallet().catch(() => {}); });
    const out = el("div", {}), err = el("div", { class: "err" });
    async function load(a) {
      err.textContent = ""; clear(out); if (!a) return;
      try {
        const { tokens } = await api("/api/wallet/" + encodeURIComponent(a));
        const total = tokens.length, collections = new Set(tokens.map((t) => t.collection)).size;
        out.append(el("div", { class: "stat-strip" },
          el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Owned NFTs" }), el("strong", { text: String(total) })),
          el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Collections" }), el("strong", { text: String(collections) })),
          el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Wallet status" }), el("strong", { text: "Connected" })),
          el("div", { class: "stat-chip" }, el("span", { class: "dim", text: "Network" }), el("strong", { text: siteNetwork }))));
        const countLabel = el("span", { class: "dim", text: total + " items" });
        out.append(el("div", { class: "section-heading" }, el("h2", { text: "Collected NFTs" }), countLabel));
        if (!tokens.length) { out.append(el("div", { class: "empty-state card" }, el("div", { class: "empty-icon", text: "✦" }), el("h3", { text: "Your collection starts here" }), el("p", { class: "dim", text: "Mint or buy an NFT and it will appear in this wallet profile." }), el("a", { class: "btn", href: "/", text: "Explore drops" }))); return; }

        // Collection filter (All = saari collections mixed) + price sort
        let selected = "", sortBy = "default";
        const byCollection = new Map();
        for (const t of tokens) byCollection.set(t.collection, { name: t.collectionName, count: (byCollection.get(t.collection)?.count ?? 0) + 1 });
        const chips = el("div", { class: "filter-chips" });
        const sortSel = el("select", { class: "sort-select", "aria-label": "Sort NFTs" },
          el("option", { value: "default", text: "Recently added" }),
          el("option", { value: "price_desc", text: "Price: High to Low" }),
          el("option", { value: "price_asc", text: "Price: Low to High" }));
        const grid = el("div", { class: "grid nfts" });
        const priceLabel = { listed: "Listed", last_sale: "Last sale", mint: "Mint price" };
        function card(t) {
          const c = nftCard(t);
          c.append(el("div", { class: "nft-price" }, el("strong", { text: t.priceZec + " ZEC" }), el("span", { class: "dim", text: priceLabel[t.priceSource] || "" })));
          return c;
        }
        function render() {
          clear(chips);
          const chip = (value, label, count) => {
            const b = el("button", { type: "button", class: "chip" + (selected === value ? " active" : ""), text: label + " (" + count + ")" });
            b.addEventListener("click", () => { selected = value; render(); });
            return b;
          };
          chips.append(chip("", "All", total));
          for (const [slug, c] of byCollection) chips.append(chip(slug, c.name, c.count));
          let list = selected ? tokens.filter((t) => t.collection === selected) : tokens.slice();
          if (sortBy !== "default") {
            const dir = sortBy === "price_desc" ? -1 : 1;
            list.sort((a, b) => { const x = BigInt(a.priceZats), y = BigInt(b.priceZats); return x === y ? 0 : (x < y ? -dir : dir); });
          }
          countLabel.textContent = list.length + " items";
          clear(grid);
          for (const t of list) grid.append(card(t));
        }
        sortSel.addEventListener("change", () => { sortBy = sortSel.value; render(); });
        out.append(el("div", { class: "wallet-toolbar" }, chips, sortSel), grid);
        render();
      } catch (ex) { err.textContent = ex.message; }
    }
    const connected = getConnectedAddress(), qsAddr = qs.get("address") || "";
    if (connected && !qsAddr) {
      const other = el("input", { type: "text", placeholder: "Kisi aur ka address dekhna ho to yahan daalo", autocomplete: "off" });
      const otherForm = el("form", { class: "inline-form" }, other, el("button", { class: "btn ghost", type: "submit", text: "View wallet" }));
      otherForm.addEventListener("submit", (e) => { e.preventDefault(); load(other.value.trim()); });
      show(el("div", { class: "eyebrow", text: "Your collector profile" }), el("h1", { text: short(connected) }), el("p", { class: "lead", text: "Your wallet, collection and on-chain identity in one place." }), el("div", { class: "wallet-profile-bar" }, el("span", { class: "mono", text: connected }), el("span", { class: "badge live", text: "Connected" })), el("details", { class: "card other-wallet" }, el("summary", { class: "dim", text: "View another wallet" }), otherForm), err, out);
      load(connected); return;
    }
    const input = el("input", { type: "text", placeholder: "Aapka t-address", value: qsAddr, autocomplete: "off" });
    const form = el("form", { class: "card inline-form" }, input, el("button", { class: "btn", type: "submit", text: "View wallet" }), err);
    form.addEventListener("submit", (e) => { e.preventDefault(); load(input.value.trim()); });
    show(el("div", { class: "eyebrow", text: "Collector profile" }), el("h1", { text: "My NFTs" }), el("p", { class: "lead", text: "Connect Noir Wallet to turn your address into a live portfolio." }), form, out);
    if (input.value) load(input.value.trim());
  }

  // ---------------- boot ----------------
  let siteNetwork = "testnet";
  function renderWalletWidget() {
    const slot = document.getElementById("walletWidget");
    if (!slot) return;
    clear(slot);
    const addr = getConnectedAddress();
    if (addr) {
      const dc = el("button", { class: "btn ghost wallet-btn", type: "button", text: short(addr) + "  Disconnect" });
      dc.addEventListener("click", () => disconnectWallet());
      slot.append(dc);
    } else {
      const cb = el("button", { class: "btn ghost wallet-btn", type: "button", text: "Connect Wallet" });
      cb.addEventListener("click", async () => {
        cb.disabled = true;
        try { await connectWallet(siteNetwork); } catch (ex) { alert(explainError(ex).message); }
        cb.disabled = false;
      });
      slot.append(cb);
    }
  }
  onWalletChange(() => { renderWalletWidget(); }); // connect/disconnect kahin bhi ho, header turant update

  api("/api/config").then(async ({ network }) => {
    siteNetwork = network;
    const n = document.getElementById("net");
    if (n) { n.textContent = network === "mainnet" ? "Mainnet" : "Testnet (test coins only)"; n.hidden = false; }
    renderWalletWidget();
    if (!getConnectedAddress()) await tryReconnect(network); // pehle se authorized ho to bina popup ke jud jaata hai
  }).catch(() => {});

  async function pageMarketplace() {
    const sort = qs.get("sort") === "trending" ? "trending" : "new";
    const q = qs.get("q") || "";
    const qsPart = (q ? "q=" + encodeURIComponent(q) + "&" : "") + (sort === "trending" ? "sort=trending" : "");
    const { collections } = await api("/api/collections" + (qsPart ? "?" + qsPart.replace(/&$/, "") : ""));
    const search = el("input", { type: "search", placeholder: "Collections khojo...", value: q });
    const searchForm = el("form", { class: "search" }, search, el("button", { class: "btn ghost", type: "submit", text: "Search" }));
    searchForm.addEventListener("submit", (e) => {
      e.preventDefault();
      location.href = "/marketplace.html?" + (search.value.trim() ? "q=" + encodeURIComponent(search.value.trim()) : "") + (sort === "trending" ? "&sort=trending" : "");
    });
    const tabs = el("div", { class: "tabs" },
      el("a", { class: "tab" + (sort === "new" ? " active" : ""), href: "/marketplace.html" + (q ? "?q=" + encodeURIComponent(q) : ""), text: "New" }),
      el("a", { class: "tab" + (sort === "trending" ? " active" : ""), href: "/marketplace.html?sort=trending" + (q ? "&q=" + encodeURIComponent(q) : ""), text: "Trending (7d)" }));

    const grid = el("div", { class: "grid" });
    if (!collections.length) grid.append(el("p", { class: "dim", text: "Koi collection nahi mili." }));
    for (const c of collections) {
      const link = "/collection.html?c=" + encodeURIComponent(c.slug);
      grid.append(
        el("div", { class: "card" },
          collectionCardArtwork(c, link),
          el("div", { class: "row" }, el("h3", {}, el("a", { href: link, text: c.name }), c.verified ? el("span", { class: "verified", title: "Verified: 20+ ZEC volume", text: " \u2713" }) : null),
            el("span", { class: "badge " + (c.frozen ? "warn" : ""), text: c.frozen ? "Frozen" : "" })),
          el("div", { class: "row" }, el("span", { class: "dim", text: "Floor" }), el("span", {}, c.floorZec ? c.floorZec + " ZEC" : el("span", { class: "dim", text: "No listings" }))),
          el("div", { class: "row" }, el("span", { class: "dim", text: "For sale" }), el("span", { text: c.listingCount + " NFT" + (c.listingCount === 1 ? "" : "s") })),
          el("div", { class: "row" }, el("span", { class: "dim", text: "Volume (7d)" }), el("span", { text: c.volumeWindowZec + " ZEC" })),
          el("div", { style: "margin-top:12px" }, el("a", { class: "btn ghost", href: link, text: "Collection dekho" }))
        )
      );
    }
    show(el("h1", { text: "Marketplace" }), el("p", { class: "dim", text: "Collection chuno, phir us collection ke andar jitni NFT bikri ke liye hain wo dikhengi." }), searchForm, tabs, grid);
  }

  async function pageActivity() {
    const g = await api("/api/activity?limit=50"), list = el("div", {}), notifications = el("div", { class: "notification-stack" });
    const LABEL = { mint: "Minted", sale: "Sold", list: "Listed", cancel_list: "Listing cancelled", airdrop: "Airdrop", offer_made: "Offer made", offer_accepted: "Offer accepted", offer_rejected: "Offer rejected" };
    if (!g.items.length) list.append(el("div", { class: "empty-state card" }, el("div", { class: "empty-icon", text: "◌" }), el("h3", { text: "The marketplace is quiet" }), el("p", { class: "dim", text: "New mints, listings and sales will appear here live." })));
    for (const a of g.items) {
      const label = LABEL[a.kind] || a.kind;
      list.append(el("div", { class: "activity-row card" }, el("span", { class: "activity-dot" }), el("div", {}, el("strong", { text: a.collectionName + (a.tokenNumber ? " #" + a.tokenNumber : "") }), el("div", { class: "dim", text: label + (a.amountZec ? " · " + a.amountZec + " ZEC" : "") })), el("time", { class: "dim", text: new Date(a.createdAt).toLocaleString() })));
      if (notifications.children.length < 3) notifications.append(el("div", { class: "notification-card" }, el("strong", { text: label }), el("span", { class: "dim", text: a.collectionName + (a.tokenNumber ? " #" + a.tokenNumber : "") })));
    }
    show(el("div", { class: "eyebrow", text: "Live marketplace feed" }), el("h1", { text: "Everything moving, live." }), el("p", { class: "lead", text: "Mints, listings, sales and offers in one real-time activity stream." }), el("div", { class: "activity-columns" }, el("section", {}, el("div", { class: "section-heading" }, el("h2", { text: "Live activity" }), el("span", { class: "badge live", text: "Live" })), list), el("aside", { class: "card notifications-panel" }, el("div", { class: "section-heading" }, el("h3", { text: "Notifications" }), el("span", { class: "dim", text: "Recent" })), notifications)));
  }

  // ---- folder read helpers (drag-drop + webkitdirectory dono ke liye) ----
  const IMG_RE = /\.(png|jpe?g|webp|gif)$/i;
  function readFileEntry(entry) {
    return new Promise((resolve, reject) => entry.file(resolve, reject));
  }
  function readDirEntry(entry) {
    return new Promise((resolve, reject) => {
      const reader = entry.createReader();
      const all = [];
      const step = () => reader.readEntries((batch) => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        step();
      }, reject);
      step();
    });
  }
  async function walkEntry(entry, out) {
    if (!entry) return;
    if (entry.isFile) out.push(await readFileEntry(entry));
    else if (entry.isDirectory) for (const child of await readDirEntry(entry)) await walkEntry(child, out);
  }
  /** DataTransfer (drop event) se saari files nikalta hai, subfolders ke andar tak (flatten). */
  async function filesFromDataTransfer(dt) {
    const items = dt.items ? Array.from(dt.items) : null;
    if (items && items[0] && items[0].webkitGetAsEntry) {
      const out = [];
      for (const it of items) {
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) await walkEntry(entry, out);
      }
      return out;
    }
    return Array.from(dt.files || []);
  }

  function csvTemplateBlob() {
    return new Blob(
      ["filename,name,description,trait:Background,trait:Eyes\n1.png,My NFT #1,,Blue,Laser\n2.png,My NFT #2,,Red,Normal\n"],
      { type: "text/csv" }
    );
  }

  async function pageCreate() {
    const err = el("div", { class: "err" });
    const msg = el("div", {});
    const name = el("input", { type: "text", placeholder: "Collection name" });
    const price = el("input", { type: "text", placeholder: "Price per NFT (ZEC), jaise 0.01" });
    const maxPerWallet = el("input", { type: "number", min: "1", value: "3" });
    const payout = el("input", { type: "text", placeholder: "Aapka payout address (t-address)" });
    const description = el("textarea", { placeholder: "Collection ke baare mein short description", rows: "3" });
    const websiteUrl = el("input", { type: "url", placeholder: "Website URL (https://...)" });
    const xUrl = el("input", { type: "url", placeholder: "X / Twitter URL (https://x.com/...)" });
    const reveal = el("select", {}, el("option", { value: "instant", text: "Turant reveal" }), el("option", { value: "after_soldout", text: "Sold out ke baad reveal" }));
    const launchAt = el("input", { type: "datetime-local" });

    let profileFile = null, bannerFile = null;
    function collectionMediaPicker(kind, title, hint) {
      const input = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", style: "display:none" });
      const preview = el("div", { class: "collection-media-preview" });
      const choose = el("button", { class: "btn ghost", type: "button", text: title });
      const field = el("div", { class: "collection-media-picker" }, el("div", { class: "dim", text: hint }), choose, input, preview);
      const render = () => {
        clear(preview);
        const selected = kind === "profile" ? profileFile : bannerFile;
        if (!selected) {
          preview.append(el("div", { class: "collection-media-empty " + kind, text: kind === "profile" ? "PFP preview" : "Banner preview" }));
          return;
        }
        preview.append(
          el("img", { src: URL.createObjectURL(selected), alt: title, class: kind === "profile" ? "collection-media-preview-avatar" : "collection-media-preview-banner" }),
          el("div", {}, el("strong", { text: selected.name }), el("div", { class: "dim", text: (selected.size / 1048576).toFixed(1) + " MB" })),
          el("button", { class: "btn ghost", type: "button", text: "Remove", onclick: () => { if (kind === "profile") profileFile = null; else bannerFile = null; render(); } })
        );
      };
      choose.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (!IMG_RE.test(file.name)) { err.textContent = "PFP/banner PNG, JPG, WebP ya GIF image honi chahiye."; return; }
        err.textContent = "";
        if (kind === "profile") profileFile = file; else bannerFile = file;
        render();
      });
      render();
      field.refreshPreview = render;
      return field;
    }
    const profilePicker = collectionMediaPicker("profile", "Choose PFP / thumbnail", "Square profile image — collection title aur cards ke paas dikhegi.");
    const bannerPicker = collectionMediaPicker("banner", "Choose banner", "Wide banner — collection page ke top par full-width dikhega.");

    // ---- Section 1: sirf IMAGES (cover.png bhi yahin) ----
    let images = []; // File[]
    const imgDrop = el("div", { class: "dropzone" },
      el("div", { class: "dz-icon", text: "\u2191" }),
      el("div", { class: "dz-text", text: "Images yahan drag-drop karo (ya poora folder)" }),
      el("div", { class: "dim", text: "PNG / JPG / WebP / GIF. Optional: ek file ka naam 'cover.png' rakho collection cover ke liye." }));
    const imgDirInput = el("input", { type: "file", webkitdirectory: "webkitdirectory", directory: "directory", multiple: "multiple", style: "display:none" });
    const imgFileInput = el("input", { type: "file", multiple: "multiple", accept: "image/png,image/jpeg,image/webp,image/gif", style: "display:none" });
    const imgPreview = el("div", { class: "dz-preview" });
    const imgThumbs = el("div", { class: "thumb-grid" });

    function summarizeImages() {
      const onlyImgs = images.filter((f) => IMG_RE.test(f.name));
      const cover = onlyImgs.find((f) => f.name.replace(/\.[^.]+$/, "").toLowerCase() === "cover");
      const rest = onlyImgs.filter((f) => f !== cover);
      clear(imgPreview); clear(imgThumbs);
      if (!onlyImgs.length) return;
      imgPreview.append(
        el("div", { class: "row" }, el("span", {}, rest.length + " images" + (cover ? " + 1 cover" : "")), el("span", { class: "dim", text: (onlyImgs.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1) + " MB" })),
        el("button", { class: "btn ghost", type: "button", text: "Clear images" }));
      imgPreview.lastChild.addEventListener("click", () => { images = []; summarizeImages(); });
      // Individual images dikhao (bahut zyada ho to pehli 24 hi, taaki page slow na ho)
      for (const f of onlyImgs.slice(0, 24)) {
        const url = URL.createObjectURL(f);
        imgThumbs.append(el("div", { class: "thumb-item" }, el("img", { src: url, class: "thumb-img" }), el("div", { class: "thumb-name", text: f.name })));
      }
      if (onlyImgs.length > 24) imgThumbs.append(el("div", { class: "thumb-item more", text: "+" + (onlyImgs.length - 24) + " aur" }));
    }
    function addImages(files) {
      const onlyImgs = Array.from(files).filter((f) => IMG_RE.test(f.name));
      const byName = new Map(images.map((f) => [f.name, f]));
      for (const f of onlyImgs) byName.set(f.name, f);
      images = [...byName.values()];
      summarizeImages();
    }
    imgDrop.addEventListener("click", () => imgDirInput.click());
    imgDrop.addEventListener("dragover", (e) => { e.preventDefault(); imgDrop.classList.add("over"); });
    imgDrop.addEventListener("dragleave", () => imgDrop.classList.remove("over"));
    imgDrop.addEventListener("drop", async (e) => {
      e.preventDefault(); imgDrop.classList.remove("over");
      try { addImages(await filesFromDataTransfer(e.dataTransfer)); } catch { err.textContent = "Folder padhne mein dikkat hui, files select karke try karo."; }
    });
    imgDirInput.addEventListener("change", () => addImages(imgDirInput.files));
    imgFileInput.addEventListener("change", () => addImages(imgFileInput.files));
    const imgPickBtn = el("button", { class: "btn ghost", type: "button", text: "Ya images chuno (folder ke bina)" });
    imgPickBtn.addEventListener("click", () => imgFileInput.click());

    // ---- Section 2: sirf METADATA (CSV ya per-image JSON, images se bilkul alag) ----
    let metaFiles = []; // File[] (csv aur/ya json)
    const metaDrop = el("div", { class: "dropzone meta" },
      el("div", { class: "dz-icon", text: "\ud83d\udcc4" }),
      el("div", { class: "dz-text", text: "Metadata yahan daalo (optional)" }),
      el("div", { class: "dim", text: "Ek metadata.csv sheet (sabse aasan), YA har image ke liye alag .json file (1.png -> 1.json)." }));
    const metaFileInput = el("input", { type: "file", multiple: "multiple", accept: ".csv,.json", style: "display:none" });
    const metaPreview = el("div", { class: "dz-preview" });
    function summarizeMeta() {
      clear(metaPreview);
      if (!metaFiles.length) { metaPreview.append(el("p", { class: "dim", text: "Koi metadata nahi (sab NFT ko generic naam mil jayega, jaise 'Collection #1')." })); return; }
      const csv = metaFiles.find((f) => /\.csv$/i.test(f.name));
      const jsons = metaFiles.filter((f) => /\.json$/i.test(f.name));
      metaPreview.append(
        csv ? el("div", { class: "row" }, el("span", {}, "CSV sheet"), el("span", { class: "dim", text: csv.name })) : null,
        jsons.length ? el("div", { class: "row" }, el("span", {}, "Per-image JSON"), el("span", { class: "dim", text: jsons.length + " file(s)" })) : null,
        el("button", { class: "btn ghost", type: "button", text: "Clear metadata" }));
      metaPreview.lastChild.addEventListener("click", () => { metaFiles = []; summarizeMeta(); });
    }
    function addMeta(files) {
      const onlyMeta = Array.from(files).filter((f) => /\.(csv|json)$/i.test(f.name));
      const byName = new Map(metaFiles.map((f) => [f.name, f]));
      for (const f of onlyMeta) byName.set(f.name, f);
      metaFiles = [...byName.values()];
      summarizeMeta();
    }
    metaDrop.addEventListener("click", () => metaFileInput.click());
    metaDrop.addEventListener("dragover", (e) => { e.preventDefault(); metaDrop.classList.add("over"); });
    metaDrop.addEventListener("dragleave", () => metaDrop.classList.remove("over"));
    metaDrop.addEventListener("drop", async (e) => {
      e.preventDefault(); metaDrop.classList.remove("over");
      try { addMeta(await filesFromDataTransfer(e.dataTransfer)); } catch { err.textContent = "Metadata padhne mein dikkat hui."; }
    });
    metaFileInput.addEventListener("change", () => addMeta(metaFileInput.files));
    summarizeMeta();

    const csvBtn = el("a", { class: "btn ghost", download: "metadata-template.csv", text: "Download CSV template" });
    csvBtn.href = URL.createObjectURL(csvTemplateBlob());

    const btn = el("button", { class: "btn", type: "submit", text: "Submit for review" });
    const progress = el("div", { class: "dim" });
    const form = el("form", { class: "card" },
      el("label", { text: "Name" }), name,
      el("label", { text: "Price per NFT (ZEC)" }), price,
      el("label", { text: "Max per wallet" }), maxPerWallet,
      el("label", { text: "Payout address" }), payout,
      el("label", { text: "Collection description (optional)" }), description,
      el("label", { text: "Website (optional)" }), websiteUrl,
      el("label", { text: "X / Twitter (optional)" }), xUrl,
      el("label", { text: "Reveal" }), reveal,
      el("label", { text: "Launch time (optional -- khaali chhodo to turant live ho jayegi review ke baad)" }), launchAt,

      el("h3", { style: "margin-top:24px", text: "Collection look (optional)" }),
      el("p", { class: "dim", text: "OpenSea-style collection profile: apna PFP/thumbnail aur wide banner choose karo. Ye token images aur supply mein count nahi honge." }),
      el("div", { class: "collection-media-pickers" }, profilePicker, bannerPicker),

      el("h3", { style: "margin-top:24px", text: "1. Images" }),
      imgDrop, imgDirInput, imgFileInput, imgPreview, imgThumbs,
      el("div", { style: "margin-top:8px" }, imgPickBtn),

      el("h3", { style: "margin-top:24px", text: "2. Preview + metadata (optional)" }),
      el("p", { class: "dim", text: "Preview image ke liye images section mein cover.png upload karo. Collection-level pre-reveal details ke liye collection.json upload karo; NFT-level metadata ke liye 1.json, 2.json ya CSV use karo." }),
      metaDrop, metaFileInput, metaPreview,
      el("div", { style: "margin-top:8px" }, csvBtn),

      el("div", { style: "margin-top:20px" }, btn), progress, err, msg);
    form.addEventListener("submit", async (e) => {
      e.preventDefault(); err.textContent = ""; msg.textContent = ""; btn.disabled = true;
      try {
        if (!images.filter((f) => IMG_RE.test(f.name)).length) throw new Error("Pehle kam se kam ek image daalo (Section 1)");
        const { sessionId } = await api("/api/creator/sessions", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.value.trim(), priceZec: price.value.trim(), maxPerWallet: maxPerWallet.value,
            payoutAddress: payout.value.trim(), description: description.value.trim(), websiteUrl: websiteUrl.value.trim(), xUrl: xUrl.value.trim(), revealMode: reveal.value,
            launchAt: launchAt.value ? new Date(launchAt.value).toISOString() : "",
          }),
        });
        const allFiles = [
          ...images.map((file) => ({ file, name: file.name })),
          ...metaFiles.map((file) => ({ file, name: file.name })),
          ...(profileFile ? [{ file: profileFile, name: "__collection_profile__." + profileFile.name.split(".").pop() }] : []),
          ...(bannerFile ? [{ file: bannerFile, name: "__collection_banner__." + bannerFile.name.split(".").pop() }] : []),
        ];
        // Har file apni ALAG request me jaati hai (seedha stream, poora collection kabhi ek saath
        // memory me nahi aata) -- isliye chhote 6-image test collection se lekar hazaron images
        // wala bada collection bhi isi ek tarike se chalta hai, bas time zyada lagta hai.
        for (let i = 0; i < allFiles.length; i++) {
          const upload = allFiles[i], f = upload.file;
          progress.textContent = "Uploading " + (i + 1) + " / " + allFiles.length + ": " + upload.name;
          const r = await fetch("/api/creator/sessions/" + sessionId + "/files?name=" + encodeURIComponent(upload.name), {
            method: "POST", headers: { "Content-Type": f.type || "application/octet-stream" }, body: f,
          });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error((j.error && j.error.message) || (upload.name + " upload fail hua")); }
        }
        progress.textContent = "Finalizing...";
        const j = await api("/api/creator/sessions/" + sessionId + "/finalize", { method: "POST" });
        progress.textContent = "";
        let m = "Submit ho gaya! Review ke baad live hoga. Slug: " + j.slug;
        if (j.csvMatched) m += "  (" + j.csvMatched + " images CSV se metadata mila)";
        if (j.csvUnmatched && j.csvUnmatched.length) m += "  (!) CSV ki ye rows kisi image se match nahi hui: " + j.csvUnmatched.join(", ");
        msg.textContent = m;
        form.reset();
        images = []; metaFiles = [];
        profileFile = null; bannerFile = null;
        profilePicker.refreshPreview(); bannerPicker.refreshPreview();
        summarizeImages(); summarizeMeta();
      } catch (ex) { err.textContent = ex.message; progress.textContent = ""; }
      btn.disabled = false;
    });
    show(el("h1", { text: "Launch your own collection" }),
      el("p", { class: "dim", text: "Pehle images daalo, phir (chaho to) metadata alag se daalo. Dono ek doosre se bilkul alag section hain." }),
      form);
  }

  const pages = { index: pageIndex, collection: pageCollection, token: pageToken, mint: pageMint, order: pageOrder, wallet: pageWallet, marketplace: pageMarketplace, activity: pageActivity, create: pageCreate };
  const run = pages[document.body.dataset.page];
  if (run) run().catch((e) => show(el("div", { class: "msg bad", text: e.message }), el("p", {}, el("a", { href: "/", text: "Home" }))));
}
