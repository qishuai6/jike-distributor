// 即刻一键分发 - 发布确认窗
const $ = (id) => document.getElementById(id);
const X_LIMIT = 280; // X 上限 280 units：CJK/全角=2，URL=23，其余=1

let syncData = null;

// ---------- X units 计算（对齐官方规则） ----------
function xUnits(text) {
  const urlRe = /https?:\/\/[^\s]+/g;
  let units = 0;
  let last = 0;
  text.replace(urlRe, (m, idx) => {
    units += unitsOf(text.slice(last, idx));
    units += 23;
    last = idx + m.length;
    return m;
  });
  units += unitsOf(text.slice(last));
  return units;
}
function unitsOf(s) {
  let u = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    u += c > 0x2e7f ? 2 : 1; // CJK、全角、emoji 区按 2 计
  }
  return u;
}
// 按 units 上限截断（保留换行），追加省略号
function truncateToUnits(text, limit) {
  const ellipsis = "…";
  let units = 0;
  let out = "";
  for (const ch of text) {
    const w = ch.codePointAt(0) > 0x2e7f ? 2 : 1;
    if (units + w > limit - 1) return out + ellipsis;
    out += ch;
    units += w;
  }
  return out;
}

// ---------- 偏好记忆（选项和平台勾选，下次打开自动恢复） ----------
const PREF_KEY = "jkDistPrefs";
const PREF_FIELDS = [
  ["optTopic", "topic"],
  ["optUrl", "url"],
  ["optTruncate", "truncate"],
  ["optAuto", "auto"],
];

function savePrefs() {
  const prefs = {};
  for (const [id, key] of PREF_FIELDS) prefs[key] = $(id).checked;
  prefs.platforms = Array.from(document.querySelectorAll(".plat")).map((p) => ({
    key: p.dataset.key,
    on: p.querySelector("input").checked,
  }));
  chrome.storage.local.set({ [PREF_KEY]: prefs }).catch(() => {});
}

function applyPrefs(prefs) {
  if (!prefs) return;
  for (const [id, key] of PREF_FIELDS) {
    if (typeof prefs[key] === "boolean") $(id).checked = prefs[key];
  }
  for (const p of prefs.platforms || []) {
    const el = document.querySelector(`.plat[data-key="${p.key}"] input`);
    if (el) el.checked = p.on;
  }
}

// ---------- 每平台正文组装 ----------
function buildContents(base, opts) {
  const contents = {};
  const withTopicAndUrl = (topicFmt) => {
    let s = base.trim();
    if (opts.topic && syncData.topic) s += `\n${topicFmt.replace("%s", syncData.topic)}`;
    if (opts.url && syncData.postUrl) s += `\n${syncData.postUrl}`;
    return s;
  };
  let x = withTopicAndUrl(" #%s");
  if (opts.truncate && xUnits(x) > X_LIMIT) x = truncateToUnits(x, X_LIMIT);
  contents.x = x;
  contents.weibo = withTopicAndUrl(" #%s#");
  contents.douban = withTopicAndUrl(" #%s#");
  return contents;
}

// ---------- 初始化 ----------
chrome.runtime.sendMessage({ action: "JK_DIST_REQUEST_SYNC_DATA" }, (resp) => {
  const data = resp && resp.syncData;
  if (!data) {
    $("errBox").textContent = "未获取到发布数据，请从即刻帖子上的「分发」按钮重新发起。";
    $("errBox").hidden = false;
    return;
  }
  syncData = data;

  const imgCount = (data.images || []).length;
  const videoNote = data.video && !data.video.url ? "（视频帖：暂以文字+封面形式分发）" : "";
  $("srcSummary").textContent =
    `来自 ${data.author || "即刻"} · ${data.timeText || ""} · ${imgCount} 图${data.video ? " · 含视频" + videoNote : ""}` +
    (data.topic ? ` · #${data.topic}#` : "");

  $("contentInput").value = data.content || "";

  const platMeta = (n, max) => `${n} 张图${n > max ? `（取前 ${max}）` : ""}`;
  $("metaX").textContent = platMeta(imgCount, 4);
  $("metaWeibo").textContent = platMeta(imgCount, 9);
  $("metaDouban").textContent = platMeta(imgCount, 9);

  $("main").hidden = false;
  chrome.storage.local.get(PREF_KEY).then((r) => applyPrefs(r && r[PREF_KEY])).catch(() => {});
  updateCount();
});

$("contentInput").addEventListener("input", updateCount);

function updateCount() {
  const v = $("contentInput").value;
  const units = xUnits(v);
  const cjk = [...v].length;
  $("charCount").textContent = `${cjk} 字 · X 计 ${units}/${X_LIMIT}`;
  $("charCount").classList.toggle("over", units > X_LIMIT);
  const over = units > X_LIMIT;
  $("xLimitHint").hidden = !over;
  if (over) {
    $("xLimitHint").textContent = $("optTruncate").checked
      ? "超出 X 上限，已开启自动截断"
      : "超出 X 上限，发布按钮会不可用，建议开启截断或删减";
  }
}
$("optTruncate").addEventListener("change", updateCount);

// ---------- 分发 ----------
$("goBtn").addEventListener("click", () => {
  if (!syncData) return;
  savePrefs();
  const platforms = Array.from(document.querySelectorAll(".plat input:checked")).map(
    (i) => i.closest(".plat").dataset.key
  );
  if (platforms.length === 0) {
    $("progress").textContent = "请至少选择一个平台";
    return;
  }

  const contents = buildContents($("contentInput").value, {
    topic: $("optTopic").checked,
    url: $("optUrl").checked,
    truncate: $("optTruncate").checked,
  });

  const payload = {
    content: $("contentInput").value,
    contents,
    images: syncData.images || [],
    isAutoPublish: $("optAuto").checked,
  };

  $("goBtn").disabled = true;
  $("progress").textContent = `正在打开 ${platforms.length} 个发布页并填充内容…（媒体上传依赖本窗口，完成前请勿关闭）`;

  chrome.runtime.sendMessage(
    { action: "JK_DIST_PUBLISH_NOW", platforms, data: payload },
    (resp) => {
      if (!resp || resp.error) {
        $("progress").textContent = `发布中断：${(resp && resp.error) || "无响应"}`;
        $("goBtn").disabled = false;
        return;
      }
      const names = (resp.tabs || []).map((t) => t.platform).join("、");
      const auto = $("optAuto").checked;
      $("progress").textContent =
        `已打开 ${names} 的发布页并归入同一标签组。\n` +
        (auto
          ? "自动发布已开启，各页将自动点击发布，稍后可点下方按钮清理标签组。"
          : "请到各平台标签页确认内容后手动点击发布；完成后可一键关闭。");
      $("goBtn").hidden = true;
      $("closeGroupBtn").hidden = false;
    }
  );
});

$("closeGroupBtn").addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "JK_DIST_CLOSE_GROUP" }, (resp) => {
    $("progress").textContent = `已关闭 ${resp?.closed ?? 0} 个发布页，完成 ✓`;
    $("closeGroupBtn").hidden = true;
    window.close();
  });
});
