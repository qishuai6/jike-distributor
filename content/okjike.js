// 即刻一键分发 - content script
// 注入 web.okjike.com：在每条动态操作栏加「分发」按钮，点击后提取帖子数据交给 background
// 选择器依据 2026-09-22 实测：卡片锚点用 button[aria-label*="点赞"]（class 均为 CSS modules 哈希，不可依赖）
//
// 2026-09-23 修「分发后回来找不到按钮」：分发流程会把即刻页切到后台，Chrome 节流后台 tab 的
// setInterval（最低 1 次/分钟），期间 React 重渲染会丢掉已注入按钮 → 回前台时按钮长时间缺失。
// 对策：visibilitychange/focus 立即补注入 + MutationObserver 即时补注入 + 工具栏图标兜底（REINJECT）。

(() => {
  // 重复注入守卫（工具栏兜底会 executeScript 重跑本文件，避免叠两套 observer/timer）
  if (window.__jkDistLoaded) return;
  window.__jkDistLoaded = true;

  const MARK = "data-jk-dist-btn";
  // 主锚=点赞；评论/转发做兜底（无点赞按钮的卡片也能注入；MARK 查重防同栏重复）
  const ANCHOR_SEL = 'button[aria-label*="点赞"], button[aria-label*="评论"], button[aria-label*="转发"]';

  // ---------- 工具 ----------

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // 从卡片内容区向上爬 React fiber，找 memoizedProps.data.id（实测在 2~5 层内）
  function findPostId(rootEl) {
    try {
      const fiberKey = Object.keys(rootEl).find((k) => k.startsWith("__reactFiber$"));
      if (!fiberKey) return null;
      let f = rootEl[fiberKey];
      for (let i = 0; i < 14 && f; i++) {
        const p = f.memoizedProps;
        if (p && typeof p === "object" && p.data && typeof p.data.id === "string" && p.data.id.length > 15) {
          return p.data.id;
        }
        f = f.return;
      }
    } catch (e) {
      /* fiber 结构变化时静默降级 */
    }
    return null;
  }

  // ---------- 提取 ----------

  async function extractPost(contentEl) {
    // 长文在列表页会被折叠，先点开「查看更多」再取全文
    const moreBtn = Array.from(contentEl.querySelectorAll("button, span, div")).find(
      (e) => !e.children.length && /查看更多/.test(e.textContent || "")
    );
    if (moreBtn) {
      try {
        (moreBtn.closest("button") || moreBtn).click();
        await sleep(300);
      } catch (e) {
        /* 点击失败则按折叠文本提取 */
      }
    }

    const wrapper =
      contentEl.querySelector('div[class*="_contentWrapper_"]') || contentEl;

    // 正文 = wrapper 内直接文本最长的块（即刻正文容器无稳定 class）
    let textEl = null;
    let best = 0;
    for (const d of wrapper.querySelectorAll("div")) {
      const t = (d.textContent || "").trim();
      if (t.length > best) {
        best = t.length;
        textEl = d;
      }
    }
    const content = textEl ? textEl.textContent.trim() : "";

    // 帖子图：alt="图片"（头像 alt 为空，天然区分）；换成七牛原画质参数（实测 2400 档比缩略图大一个量级）
    const images = [];
    const seen = new Set();
    for (const img of wrapper.querySelectorAll('img[alt="图片"]')) {
      const src = img.currentSrc || img.src;
      if (!src || !src.includes("ruguoapp.com")) continue;
      const base = src.split("?")[0];
      if (seen.has(base)) continue;
      seen.add(base);
      const ext = (base.split(".").pop() || "jpg").toLowerCase();
      const type = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
      images.push({
        kind: "image",
        url: base + "?imageMogr2/auto-orient/thumbnail/2400x2400",
        name: `jike-${images.length + 1}.${ext}`,
        type,
      });
    }

    // 视频：即刻网页播放器是 blob:(MSE)，从 performance 里找本页加载过的 mp4 直链
    let video = null;
    const videoEl = wrapper.querySelector("video");
    if (videoEl) {
      const mp4 = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => /\.mp4(\?|$)/.test(u) && u.includes("ruguoapp.com"))
        .pop();
      video = {
        kind: "video",
        url: mp4 || null,
        poster: (videoEl.poster || "").split("?")[0] || null,
        name: "jike-video.mp4",
        type: "video/mp4",
      };
    }

    // 圈子、作者、时间
    const topicLink = contentEl.querySelector('a[href^="/topic/"]');
    const header = contentEl.querySelector("header");
    const userLink = (header || contentEl).querySelector('a[href^="/u/"]');
    const timeEl = Array.from((header || contentEl).querySelectorAll("div,span,time")).find((e) =>
      !e.children.length && /^(刚刚|\d+\s*(秒|分钟|小时|天)前|\d{1,2}月\d{1,2}日)/.test((e.textContent || "").trim())
    );

    const postId = findPostId(contentEl.parentElement || contentEl);

    return {
      content,
      images,
      video,
      topic: topicLink ? topicLink.textContent.trim() : "",
      author: userLink ? userLink.textContent.trim() : "",
      timeText: timeEl ? timeEl.textContent.trim() : "",
      postId,
      postUrl: postId ? `https://web.okjike.com/originalPost/${postId}` : "",
      source: "okjike",
    };
  }

  // ---------- 按钮注入 ----------

  function buildButton() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute(MARK, "1");
    btn.title = "分发到 X / 微博 / 豆瓣（找不到按钮时可点浏览器工具栏的本扩展图标恢复）";
    Object.assign(btn.style, {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      border: "none",
      background: "transparent",
      color: "inherit",
      fontSize: "inherit",
      fontWeight: "500",
      cursor: "pointer",
      padding: "4px 8px",
      borderRadius: "6px",
    });
    const ICON_COLOR = "#F5B70A"; // 琥珀黄：白底下可辨，和即刻原生灰图标一眼区分
    const HOVER_COLOR = "#F5C518";
    // 纸飞机图标（Material send path，fill 直写便于 hover 单独控制）
    const iconWrap = document.createElement("span");
    iconWrap.style.cssText = "display:inline-flex;flex:none";
    iconWrap.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="' +
      ICON_COLOR + '" d="M2.01 21 23 12 2.01 3 2 10l15 2-15 2 .01 7z"/></svg>';
    const label = document.createElement("span");
    label.textContent = "分发";
    btn.appendChild(iconWrap);
    btn.appendChild(label);
    btn.addEventListener("mouseenter", () => {
      btn.style.color = HOVER_COLOR;
      const p = btn.querySelector("svg path");
      if (p) p.setAttribute("fill", HOVER_COLOR);
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.color = "inherit";
      const p = btn.querySelector("svg path");
      if (p) p.setAttribute("fill", ICON_COLOR);
    });
    return btn;
  }

  function setBtnLabel(btn, text) {
    const s = btn.querySelector("span:last-child");
    if (s) s.textContent = text;
  }

  function getCardFromAnchor(anchorBtn) {
    // 操作栏按钮 -> 操作栏 -> 内容区（实测层级：btn -> div(操作栏) -> div -> div(内容区)）
    let el = anchorBtn;
    for (let i = 0; i < 3 && el.parentElement; i++) el = el.parentElement;
    return el;
  }

  function injectButtons() {
    for (const anchor of document.querySelectorAll(ANCHOR_SEL)) {
      const bar = anchor.parentElement;
      if (!bar || bar.querySelector(`[${MARK}]`)) continue;
      const btn = buildButton();
      btn.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        setBtnLabel(btn, "…");
        try {
          const card = getCardFromAnchor(anchor);
          const data = await extractPost(card);
          if (!data.content && data.images.length === 0 && !data.video) {
            setBtnLabel(btn, "空");
            setTimeout(() => setBtnLabel(btn, "分发"), 1200);
            return;
          }
          await chrome.runtime.sendMessage({ action: "JK_DIST_OPEN_PUBLISH", data });
          setBtnLabel(btn, "已发起");
        } catch (e) {
          console.error("[即刻分发] 提取失败:", e);
          setBtnLabel(btn, "失败");
        }
        setTimeout(() => setBtnLabel(btn, "分发"), 1500);
      });
      bar.insertBefore(btn, bar.firstChild);
    }
  }

  // ---------- 启动 ----------

  const start = () => {
    injectButtons();

    // 定时兜底（SPA 滚动加载新卡片）
    setInterval(injectButtons, 1500);

    // DOM 一变就补（React 重渲染丢按钮时 200ms 内恢复；setInterval 只做兜底）
    let pending = null;
    new MutationObserver(() => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        injectButtons();
      }, 200);
    }).observe(document.body, { childList: true, subtree: true });

    // 回前台/回焦点立即补（后台标签页的 setInterval 被 Chrome 节流到分钟级，这是
    // 「分发完豆瓣回来找不到按钮」的主因）
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) injectButtons();
    });
    window.addEventListener("focus", injectButtons);
  };

  // 工具栏图标兜底：background 发 REINJECT 时强制重注入
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "JK_DIST_REINJECT") injectButtons();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
