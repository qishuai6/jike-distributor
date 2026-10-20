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

    const tab = await chrome.tabs.create({ url: p.injectUrl, active: false });

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

    await chrome.tabs.update(tab.id, { active: true });

    try {
      if (groupId) {
        await chrome.tabs.group({ tabIds: [tab.id], groupId });
      } else {
        groupId = await chrome.tabs.group({ tabIds: [tab.id] });
        await chrome.tabGroups.update(groupId, {
          color: "yellow",
          title: `即刻分发-${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
        });
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
      await sleep(4000);
      status(`已点击发布 ✓ 请稍候确认${cleaned ? "（已清除微博附加的「收起」）" : ""}`);
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

    if (data.isAutoPublish) {
      const btn = await waitFor(
        () => Array.from(document.querySelectorAll("button, a.btn")).find((b) => /发广播|发送|发布/.test(b.textContent || "")),
        10000
      );
      if (!btn) return status("未找到发布按钮", true);
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
