// 即刻一键分发 - background service worker
// 架构继承自 x-distributor：发布确认窗 + 每平台开官方发布页 + executeScript 注入自包含 adapter
// adapter 函数必须完全自包含（executeScript 序列化后闭包失效）

// ---------------- 平台表 ----------------

const PLATFORMS = [
  {
    key: "x",
    name: "X",
    injectUrl: "https://x.com/compose/post",
    maxImages: 4,
    injectFunction: publishX,
  },
  {
    key: "weibo",
    name: "微博",
    injectUrl: "https://weibo.com/",
    maxImages: 9,
    injectFunction: publishWeibo,
  },
  {
    key: "douban",
    name: "豆瓣",
    injectUrl: "https://www.douban.com/",
    maxImages: 9,
    injectFunction: publishDouban,
  },
  {
    key: "threads",
    name: "Threads",
    // 官方 intent 直链：发布弹窗直接预填正文，免去侧栏点「发帖」按钮（injectUrl 支持函数，按稿件生成）
    injectUrl: (data) =>
      `https://www.threads.com/intent/post?text=${encodeURIComponent(data.content || "")}`,
    maxImages: 10,
    injectFunction: publishThreads,
  },
];

let pendingData = null; // 发布窗数据
let currentGroupId = undefined; // 本轮发布页分组

// ---------------- 工具栏图标兜底：找不到「分发」按钮时点它恢复 ----------------

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || !tab.url.startsWith("https://web.okjike.com/")) {
    await chrome.tabs.create({ url: "https://web.okjike.com/" });
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { action: "JK_DIST_REINJECT" });
  } catch (e) {
    // content script 已失效（扩展重载后页面未刷新等）：直接重新注入（脚本自带防重复守卫）
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content/okjike.js"],
      });
    } catch (e2) {
      console.error("[即刻分发] 重新注入失败:", e2);
      return;
    }
  }
  try {
    await chrome.action.setBadgeText({ text: "✓" });
    await chrome.action.setBadgeBackgroundColor({ color: "#F5B70A" });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), 1500);
  } catch (e) {
    /* badge 失败不影响功能 */
  }
});

// ---------------- 消息路由 ----------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "JK_DIST_OPEN_PUBLISH") {
    pendingData = msg.data;
    chrome.windows
      .create({
        url: chrome.runtime.getURL("tabs/publish.html"),
        type: "popup",
        width: 480,
        height: 700,
      })
      .catch((e) => console.error("[即刻分发] 打开发布窗失败:", e));
    sendResponse({ status: "received" });
    return true;
  }

  if (msg.action === "JK_DIST_REQUEST_SYNC_DATA") {
    sendResponse({ syncData: pendingData });
    return true;
  }

  if (msg.action === "JK_DIST_FETCH_IMAGE_DATA") {
    (async () => {
      try {
        const r = await fetch(String(msg.url), { credentials: "omit" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const blob = await r.blob();
        const dataUrl = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onloadend = () => resolve(fr.result);
          fr.onerror = () => reject(new Error("FileReader 读取失败"));
          fr.readAsDataURL(blob);
        });
        sendResponse({ ok: true, dataUrl });
      } catch (e) {
        sendResponse({ ok: false, error: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "JK_DIST_PUBLISH_NOW") {
    const { platforms, data } = msg;
    if (!Array.isArray(platforms) || platforms.length === 0) {
      sendResponse({ error: "未选择任何平台" });
      return true;
    }
    (async () => {
      try {
        const { tabs, groupId } = await createTabsForPlatforms(platforms, data);
        currentGroupId = groupId;
        sendResponse({ ok: true, tabs: tabs.map((t) => ({ platform: t.platformLabel, title: t.tab.title })) });
      } catch (e) {
        console.error("[即刻分发] 创建发布页失败:", e);
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  if (msg.action === "JK_DIST_CLOSE_GROUP") {
    (async () => {
      try {
        if (!currentGroupId) return sendResponse({ closed: 0 });
        const tabsInGroup = await chrome.tabs.query({ groupId: currentGroupId });
        const ids = tabsInGroup.map((t) => t.id).filter(Boolean);
        await chrome.tabs.remove(ids);
        currentGroupId = undefined;
        sendResponse({ closed: ids.length });
      } catch (e) {
        sendResponse({ error: String(e) });
      }
    })();
    return true;
  }

  return false;
});

// ---------------- 建标签页并注入 ----------------

// Chrome 在标签拖拽中会临时拒绝 tabs API（"Tabs cannot be edited right now"），等拖拽结束重试
const withTabRetry = async (fn, tries = 6) => {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries - 1 || !/cannot be edited right now/i.test(String(e))) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
};

async function createTabsForPlatforms(platformKeys, data) {
  let groupId;
  const created = [];

  for (const key of platformKeys) {
    const p = PLATFORMS.find((x) => x.key === key);
    if (!p) continue;

    // 按平台裁剪数据
    const platformData = {
      content: data.contents?.[key] ?? data.content ?? "",
      images: (data.images || []).slice(0, p.maxImages),
      video: null, // v0.1：即刻视频直链抓取不稳定，暂以图文分发（poster 已并入 images 流程外，此处不传）
      isAutoPublish: !!data.isAutoPublish,
    };

    const tab = await withTabRetry(() =>
      chrome.tabs.create({
        url: typeof p.injectUrl === "function" ? p.injectUrl(platformData) : p.injectUrl,
        active: false,
      })
    );

    // 等页面加载完成（上限 15s，超时也尝试注入）
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve();
      };
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") finish();
      };
      const timer = setTimeout(finish, 15000);
      chrome.tabs.onUpdated.addListener(listener);
    });

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: p.injectFunction,
        args: [platformData],
      });
    } catch (e) {
      console.error(`[即刻分发] 注入 ${p.name} 失败:`, e);
    }

    await withTabRetry(() => chrome.tabs.update(tab.id, { active: true }));

    try {
      if (groupId) {
        await withTabRetry(() => chrome.tabs.group({ tabIds: [tab.id], groupId }));
      } else {
        groupId = await withTabRetry(() => chrome.tabs.group({ tabIds: [tab.id] }));
        await withTabRetry(() =>
          chrome.tabGroups.update(groupId, {
            color: "yellow",
            title: `即刻分发-${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
          })
        );
      }
    } catch (e) {
      console.warn("[即刻分发] 标签分组失败（不影响发布）:", e);
    }

    created.push({ tab, platformLabel: p.name });
    await new Promise((r) => setTimeout(r, 3000));
  }

  return { tabs: created, groupId };
}

// ==================== 以下为注入目标页面的 adapter（必须自包含） ====================

// ---------- X ----------
async function publishX(data) {
  const status = (text, isError) => {
    let bar = document.getElementById("jk-dist-status");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "jk-dist-status";
      bar.style.cssText =
        "position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1d9bf0;color:#fff;padding:6px 14px;border-radius:0 0 8px 8px;font:13px/1.4 system-ui;max-width:90vw;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(bar);
    }
    if (isError) bar.style.background = "#d93025";
    bar.textContent = `[即刻分发→X] ${text}`;
  };
  const waitFor = (sel, timeout = 12000) =>
    new Promise((resolve) => {
      const el = document.querySelector(sel);
      if (el) return resolve(el);
      const mo = new MutationObserver(() => {
        const el = document.querySelector(sel);
        if (el) {
          mo.disconnect();
          clearTimeout(t);
          resolve(el);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(() => {
        mo.disconnect();
        resolve(null);
      }, timeout);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    status("等待发帖框…");
    const editor = await waitFor('div[data-testid="tweetTextarea_0"][contenteditable="true"]') ||
      await waitFor('div[role="textbox"][contenteditable="true"]');
    if (!editor) {
      status("未找到发帖框（请确认已登录 X，或页面已改版）", true);
      return;
    }

    // 图片优先（先图后文，避免文本抢占焦点）
    if (data.images && data.images.length) {
      status(`上传图片 0/${data.images.length}…`);
      const dt = new DataTransfer();
      let loaded = 0;
      for (const img of data.images) {
        let blob;
        try {
          const r = await fetch(img.url, { credentials: "omit" });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          blob = await r.blob();
        } catch (e) {
          const resp = await new Promise((resolve) => {
            try {
              chrome.runtime.sendMessage({ action: "JK_DIST_FETCH_IMAGE_DATA", url: img.url }, resolve);
              setTimeout(() => resolve({ ok: false, error: "timeout" }), 20000);
            } catch (e2) {
              resolve({ ok: false, error: String(e2) });
            }
          });
          if (!resp || !resp.ok) {
            status(`图片 ${img.name} 下载失败：${resp?.error || e}`, true);
            continue;
          }
          blob = await (await fetch(resp.dataUrl)).blob();
        }
        dt.items.add(new File([blob], img.name, { type: img.type }));
        loaded++;
      }
      if (loaded > 0) {
        editor.focus();
        const pasteEvt = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
        editor.dispatchEvent(pasteEvt);
        await sleep(2500);
        // 校验：稿件区出现图片，否则走 file input 兜底
        const draft = editor.closest("form") || editor.closest('div[role="dialog"]') || document;
        if (!draft.querySelectorAll("img").length) {
          status("改用文件选择框上传…");
          const fileInput = await waitFor('input[data-testid="fileInput"]') || document.querySelector('input[type="file"]');
          if (fileInput) {
            const dt2 = new DataTransfer();
            for (const img of data.images) {
              try {
                const r = await fetch(img.url, { credentials: "omit" });
                const b = await r.blob();
                dt2.items.add(new File([b], img.name, { type: img.type }));
              } catch (e) { /* 跳过该图 */ }
            }
            fileInput.files = dt2.files;
            fileInput.dispatchEvent(new Event("change", { bubbles: true }));
            await sleep(2500);
          }
        }
      }
    }

    // 正文
    status("填写正文…");
    editor.focus();
    const textEvt = new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: new DataTransfer(),
    });
    textEvt.clipboardData.setData("text/plain", data.content || "");
    editor.dispatchEvent(textEvt);
    await sleep(1500);

    if (data.isAutoPublish) {
      status("等待发布按钮可用…");
      const btn = await waitFor('button[data-testid="tweetButton"]', 15000) ||
        await waitFor('button[data-testid="tweetButtonInline"]', 5000);
      if (!btn) return status("未找到发布按钮", true);
      let tries = 0;
      while ((btn.disabled || btn.getAttribute("aria-disabled") === "true") && tries < 60) {
        await sleep(1000);
        tries++;
      }
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        status("发布按钮不可用（常见原因：正文超 280 字符上限 / 图片未传完），请手动检查", true);
        return;
      }
      btn.click();
      await sleep(4000);
      status("已点击发布 ✓ 请稍候确认", false);
    } else {
      status("内容已就绪，请手动点击发布", false);
    }
  } catch (e) {
    status(`出错：${e}`, true);
  }
}

// ---------- 微博 ----------
async function publishWeibo(data) {
  const status = (text, isError) => {
    let bar = document.getElementById("jk-dist-status");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "jk-dist-status";
      bar.style.cssText =
        "position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#ff8200;color:#fff;padding:6px 14px;border-radius:0 0 8px 8px;font:13px/1.4 system-ui;max-width:90vw;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(bar);
    }
    if (isError) bar.style.background = "#d93025";
    bar.textContent = `[即刻分发→微博] ${text}`;
  };
  const waitFor = (check, timeout = 12000) =>
    new Promise((resolve) => {
      const first = check();
      if (first) return resolve(first);
      const mo = new MutationObserver(() => {
        const el = check();
        if (el) {
          mo.disconnect();
          clearTimeout(t);
          resolve(el);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(() => {
        mo.disconnect();
        resolve(null);
      }, timeout);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pickEditor = () =>
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector('textarea[placeholder*="新鲜事"]') ||
    document.querySelector('textarea[placeholder*="分享"]') ||
    document.querySelector('div[contenteditable="true"]');

  try {
    status("等待发布框…");
    const editor = await waitFor(pickEditor);
    if (!editor) {
      status("未找到微博发布框（请确认已登录；若页面改版请反馈 DOM 截图）", true);
      return;
    }

    // 图片：微博首页「图片」入口背后是隐藏 input[type=file]
    if (data.images && data.images.length) {
      status("上传图片…");
      const fileInput =
        (await waitFor(() => document.querySelector('input[type="file"][accept*="image"]'), 6000)) ||
        document.querySelector('input[type="file"]');
      if (!fileInput) {
        status("未找到图片上传入口，仅发文字", true);
      } else {
        const dt = new DataTransfer();
        for (const img of data.images) {
          try {
            const r = await fetch(img.url, { credentials: "omit" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const b = await r.blob();
            dt.items.add(new File([b], img.name, { type: img.type }));
          } catch (e) {
            const resp = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage({ action: "JK_DIST_FETCH_IMAGE_DATA", url: img.url }, resolve);
                setTimeout(() => resolve({ ok: false }), 20000);
              } catch (e2) {
                resolve({ ok: false });
              }
            });
            if (resp && resp.ok) {
              const b = await (await fetch(resp.dataUrl)).blob();
              dt.items.add(new File([b], img.name, { type: img.type }));
            }
          }
        }
        if (dt.files.length) {
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          fileInput.dispatchEvent(new Event("input", { bubbles: true }));
          await sleep(3000);
        }
      }
    }

    // 正文
    status("填写正文…");
    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      editor.value = data.content || "";
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const evt = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      evt.clipboardData.setData("text/plain", data.content || "");
      editor.dispatchEvent(evt);
    }
    await sleep(1500);

    // 微博长文会在编辑器内部塞入「收起/展开」折叠控件，随正文一起发出 → 发布前清除
    const cleanCollapse = () => {
      let removed = false;
      for (const el of Array.from(editor.querySelectorAll("*"))) {
        const t = (el.textContent || "").trim();
        if (el.children.length === 0 && (t === "收起" || t === "展开")) {
          el.remove();
          removed = true;
        }
      }
      const last = editor.lastChild;
      if (last && last.nodeType === 3 && /(收起|展开)\s*$/.test(last.textContent || "")) {
        last.textContent = (last.textContent || "").replace(/(收起|展开)\s*$/, "");
        removed = true;
      }
      return removed;
    };
    const cleaned = cleanCollapse();

    if (data.isAutoPublish) {
      status("等待发布按钮…");
      const btn = await waitFor(
        () =>
          Array.from(document.querySelectorAll("button")).find((b) => /发博|发送|发布/.test(b.textContent || "")),
        10000
      );
      if (!btn) return status("未找到发布按钮", true);
      let tries = 0;
      while ((btn.disabled || btn.getAttribute("aria-disabled") === "true") && tries < 30) {
        await sleep(1000);
        tries++;
      }
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        return status("发布按钮不可用（可能正文超限或图片未传完），请手动检查", true);
      }
      cleanCollapse(); // 折叠控件可能是编辑器展开后晚插入的，点击前再清一次
      btn.click();

      // 确认发布结果：编辑器被清空 / 「发布成功」提示，最长 45s
      let published = false;
      const confirmDeadline = Date.now() + 45000;
      while (Date.now() < confirmDeadline) {
        if (editor.isConnected && (editor.textContent || "").trim() === "") { published = true; break; }
        const toast = Array.from(document.querySelectorAll("div, span, p")).find(
          (e) => e.children.length === 0 && /发布成功|发送成功/.test(e.textContent || "")
        );
        if (toast) { published = true; break; }
        await sleep(1000);
      }
      status(
        published
          ? `发布成功 ✓${cleaned ? "（已清除微博附加的「收起」）" : ""}`
          : `已点击发布但未能确认结果，请到微博主页核实最新一条${cleaned ? "（已清除「收起」）" : ""}`,
        !published
      );
    } else {
      status(`内容已就绪，请手动点击发布${cleaned ? "（已清除微博附加的「收起」）" : ""}`);
    }
  } catch (e) {
    status(`出错：${e}`, true);
  }
}

// ---------- 豆瓣 ----------
async function publishDouban(data) {
  const status = (text, isError) => {
    let bar = document.getElementById("jk-dist-status");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "jk-dist-status";
      bar.style.cssText =
        "position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#007722;color:#fff;padding:6px 14px;border-radius:0 0 8px 8px;font:13px/1.4 system-ui;max-width:90vw;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(bar);
    }
    if (isError) bar.style.background = "#d93025";
    bar.textContent = `[即刻分发→豆瓣] ${text}`;
  };
  const waitFor = (check, timeout = 12000) =>
    new Promise((resolve) => {
      const first = check();
      if (first) return resolve(first);
      const mo = new MutationObserver(() => {
        const el = check();
        if (el) {
          mo.disconnect();
          clearTimeout(t);
          resolve(el);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(() => {
        mo.disconnect();
        resolve(null);
      }, timeout);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pickEditor = () =>
    document.querySelector("#isay textarea") ||
    document.querySelector('textarea[placeholder*="分享"]') ||
    document.querySelector('textarea[placeholder*="想法"]') ||
    document.querySelector('textarea[placeholder*="说"]') ||
    document.querySelector('div[contenteditable="true"][role="textbox"]') ||
    document.querySelector("textarea");

  try {
    status("等待「我说」广播框…");
    const editor = await waitFor(pickEditor);
    if (!editor) {
      status("未找到豆瓣广播框（请确认已登录且在首页；若页面改版请反馈 DOM 截图）", true);
      return;
    }

    if (data.images && data.images.length) {
      status("上传图片…");
      const fileInput = (await waitFor(() => document.querySelector('input[type="file"]'), 6000));
      if (!fileInput) {
        status("未找到图片上传入口，仅发文字", true);
      } else {
        const dt = new DataTransfer();
        for (const img of data.images) {
          try {
            const r = await fetch(img.url, { credentials: "omit" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const b = await r.blob();
            dt.items.add(new File([b], img.name, { type: img.type }));
          } catch (e) {
            const resp = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage({ action: "JK_DIST_FETCH_IMAGE_DATA", url: img.url }, resolve);
                setTimeout(() => resolve({ ok: false }), 20000);
              } catch (e2) {
                resolve({ ok: false });
              }
            });
            if (resp && resp.ok) {
              const b = await (await fetch(resp.dataUrl)).blob();
              dt.items.add(new File([b], img.name, { type: img.type }));
            }
          }
        }
        if (dt.files.length) {
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(3000);
        }
      }
    }

    // 正文：textarea 必须走浏览器原生输入路径 —— 豆瓣发博工具栏（含发布按钮）要吃到真实输入
    // 事件才会渲染，value 赋值 + 合成 input 不触发展开，发布按钮在 DOM 里根本不存在
    status("填写正文…");
    editor.focus();
    if (editor.tagName === "TEXTAREA") {
      editor.select();
      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, data.content || "");
      } catch (e) { /* execCommand 在极端场景可能抛错 */ }
      if (!inserted) {
        editor.value = data.content || "";
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      }
      // 补键盘/点击事件：展开逻辑若绑在 keyup/click 上也能命中（合成事件无默认插入行为，不会重复输入）
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
      editor.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
      editor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    } else {
      const evt = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      evt.clipboardData.setData("text/plain", data.content || "");
      editor.dispatchEvent(evt);
    }
    await sleep(1500);

    // 豆瓣长文同样会在编辑器内部塞入「收起/展开」折叠控件，随正文一起发出 → 发布前清除
    const cleanCollapse = () => {
      let removed = false;
      for (const el of Array.from(editor.querySelectorAll("*"))) {
        const t = (el.textContent || "").trim();
        if (el.children.length === 0 && (t === "收起" || t === "展开")) {
          el.remove();
          removed = true;
        }
      }
      const last = editor.lastChild;
      if (last && last.nodeType === 3 && /(收起|展开)\s*$/.test(last.textContent || "")) {
        last.textContent = (last.textContent || "").replace(/(收起|展开)\s*$/, "");
        removed = true;
      }
      return removed;
    };
    const cleaned = cleanCollapse();

    // 豆瓣发布按钮是 a.bn-flat 包 input[type=button]（文字在 value 属性，textContent 为空）。
    // scope 必须全页：工具栏展开时豆瓣会重建编辑器区域 DOM，editor 引用随之脱离文档，
    // 从它向上爬容器永远扫不到新树里的按钮（v0.2.0 前的 bug）→ 精确匹配防全页误伤
    const labelOf = (b) =>
      `${b.textContent || ""} ${b.value || ""} ${(b.getAttribute && b.getAttribute("value")) || ""}`;
    const isPublishLabel = (b) => {
      if (b.tagName === "A" && /^https?:/.test((b.getAttribute && b.getAttribute("href")) || "")) return false;
      return /^(发布|发送|发广播)$/.test(labelOf(b).trim());
    };
    const findBtn = () =>
      Array.from(
        document.querySelectorAll(
          'button, input[type="button"], input[type="submit"], [role="button"], a[class*="btn"], a[class*="bn"]'
        )
      ).find(isPublishLabel);
    // 等待期间用户可能已手动点发布：出现「发布成功」提示即视为完成
    const findPublished = () =>
      Array.from(document.querySelectorAll("div, span, p")).find(
        (e) => e.children.length === 0 && /发布成功/.test(e.textContent || "")
      );

    if (data.isAutoPublish) {
      // ---- 提交阶段：自动点按钮 → Cmd+Enter 快捷键 → 请用户手动点，任一生效即可 ----
      status("等待发布按钮…（若约 10 秒后仍未继续，请用鼠标点一下发博框）");
      let clicked = false;
      let published = findPublished();
      const submitDeadline = Date.now() + 30000;
      while (!published && Date.now() < submitDeadline) {
        const btn = findBtn();
        if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
          cleanCollapse(); // 折叠控件可能是编辑器展开后晚插入的，点击前再清一次
          btn.click();
          clicked = true;
          break;
        }
        if (findPublished()) { published = true; break; }
        await sleep(500);
      }
      if (!clicked && !published) {
        // 兜底：模拟 Cmd+Enter 提交（合成事件无默认插入行为，不会重复输入）
        status("未找到发布按钮，尝试快捷键提交…");
        editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
        editor.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", metaKey: true, bubbles: true }));
        await sleep(3000);
        published = findPublished();
      }

      // ---- 确认阶段：盯成功信号（「发布成功」提示 / 编辑器被清空）最长 60s，含人工点发布的窗口 ----
      if (!published) {
        status(clicked ? "已点击发布，确认结果中…" : "请手动点一下「发布」按钮，我会确认结果…");
        const confirmDeadline = Date.now() + 60000;
        while (Date.now() < confirmDeadline) {
          if (findPublished()) { published = true; break; }
          if (editor.isConnected && editor.value === "") { published = true; break; }
          await sleep(1000);
        }
      }
      if (published) {
        status(`发布成功 ✓${clicked ? "" : "（检测到你已发布）"}${cleaned ? " 已清除「收起」" : ""}`);
      } else {
        status(
          `未能确认发布结果（${clicked ? "已点击过发布按钮" : "自动提交未成功"}）。内容已填好，请到豆瓣主页核实最新一条；若未发出请手动点发布`,
          true
        );
      }
    } else {
      status(`内容已就绪，请手动点击发布${cleaned ? "（已清除豆瓣附加的「收起」）" : ""}`);
    }
  } catch (e) {
    status(`出错：${e}`, true);
  }
}

// ---------- Threads ----------
// injectUrl 已用 intent/post 直链预填正文，adapter 只负责图片与发布
async function publishThreads(data) {
  const status = (text, isError) => {
    let bar = document.getElementById("jk-dist-status");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "jk-dist-status";
      bar.style.cssText =
        "position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;background:#000;color:#fff;padding:6px 14px;border-radius:0 0 8px 8px;font:13px/1.4 system-ui;max-width:90vw;box-shadow:0 2px 8px rgba(0,0,0,.3)";
      document.body.appendChild(bar);
    }
    if (isError) bar.style.background = "#d93025";
    bar.textContent = `[即刻分发→Threads] ${text}`;
  };
  const waitFor = (check, timeout = 12000) =>
    new Promise((resolve) => {
      const first = check();
      if (first) return resolve(first);
      const mo = new MutationObserver(() => {
        const el = check();
        if (el) {
          mo.disconnect();
          clearTimeout(t);
          resolve(el);
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
      const t = setTimeout(() => {
        mo.disconnect();
        resolve(null);
      }, timeout);
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    status("等待发帖框…");
    // 只认可见的编辑器（intent 弹窗里可能有隐藏复本）
    const editor = await waitFor(() =>
      Array.from(document.querySelectorAll('div[contenteditable="true"][role="textbox"]')).find(
        (e) => e.offsetParent !== null
      )
    );
    if (!editor) {
      status("未找到 Threads 发帖框（请确认已登录；若页面改版请反馈 DOM 截图）", true);
      return;
    }

    // 图片：弹窗附件入口背后是 input[type=file]，找不到时先点「图片」图标唤出
    if (data.images && data.images.length) {
      status(`上传图片 0/${data.images.length}…`);
      let fileInput = await waitFor(() => document.querySelector('input[type="file"][accept*="image"]'), 5000);
      if (!fileInput) {
        const mediaBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) =>
          /图片|照片|相册|photo|media|image/i.test(b.getAttribute("aria-label") || "")
        );
        if (mediaBtn) {
          mediaBtn.click();
          await sleep(800);
          fileInput = document.querySelector('input[type="file"][accept*="image"]');
        }
      }
      if (!fileInput) {
        status("未找到图片上传入口，仅发文字", true);
      } else {
        const dt = new DataTransfer();
        let loaded = 0;
        for (const img of data.images) {
          let blob;
          try {
            const r = await fetch(img.url, { credentials: "omit" });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            blob = await r.blob();
          } catch (e) {
            const resp = await new Promise((resolve) => {
              try {
                chrome.runtime.sendMessage({ action: "JK_DIST_FETCH_IMAGE_DATA", url: img.url }, resolve);
                setTimeout(() => resolve({ ok: false, error: "timeout" }), 20000);
              } catch (e2) {
                resolve({ ok: false, error: String(e2) });
              }
            });
            if (!resp || !resp.ok) {
              status(`图片 ${img.name} 下载失败：${resp?.error || e}`, true);
              continue;
            }
            blob = await (await fetch(resp.dataUrl)).blob();
          }
          dt.items.add(new File([blob], img.name, { type: img.type }));
          loaded++;
        }
        if (loaded > 0) {
          fileInput.files = dt.files;
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(3000);
          status(`已上传 ${loaded} 张图片`);
        }
      }
    }

    // 正文：intent 直链已预填，只在没填上时补填（paste 原生路径）
    status("检查正文…");
    const existing = (editor.textContent || "").replace(/\u00a0/g, " ").trim();
    if (existing !== (data.content || "").trim()) {
      editor.focus();
      const evt = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      evt.clipboardData.setData("text/plain", data.content || "");
      editor.dispatchEvent(evt);
      await sleep(1200);
    }

    if (data.isAutoPublish) {
      status("等待发布按钮…");
      const findBtn = () =>
        Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
          const label = `${b.textContent || ""} ${b.getAttribute("aria-label") || ""}`.trim();
          return /^(发布|post)$/i.test(label) || /^(分享|share)$/i.test(label);
        });
      const btn = await waitFor(findBtn, 15000);
      if (!btn) return status("未找到发布按钮", true);
      let tries = 0;
      while ((btn.disabled || btn.getAttribute("aria-disabled") === "true") && tries < 30) {
        await sleep(1000);
        tries++;
      }
      if (btn.disabled || btn.getAttribute("aria-disabled") === "true") {
        return status("发布按钮不可用（可能正文超 500 字上限或图片未传完），请手动检查", true);
      }
      btn.click();
      await sleep(4000);
      status("已点击发布 ✓ 请稍候确认");
    } else {
      status("内容已就绪，请手动点击发布");
    }
  } catch (e) {
    status(`出错：${e}`, true);
  }
}
