/* 录制专用虚拟鼠标 · clean-recorder · 无字幕版本
   runner.mjs 注入 · 暴露 window.__rec API（cursor + ripple 两层，无字幕）*/
(() => {
  if (window.__rec) return;

  function injectStyle() {
    if (document.querySelector("style[data-rec-style]")) return;
    const css = window.__REC_CSS__;
    if (!css) return;
    const target = document.head || document.documentElement;
    if (!target) return;
    const style = document.createElement("style");
    style.setAttribute("data-rec-style", "1");
    style.textContent = css;
    target.appendChild(style);
  }

  function mount() {
    injectStyle();

    const cursor = document.createElement("div");
    cursor.className = "__rec-cursor";
    cursor.setAttribute("data-rec-overlay", "cursor");
    cursor.innerHTML =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">' +
      '<path d="M5.5 3.21V20.8c0 .45.54.67.85.35l4.86-4.86a.5.5 0 0 1 .35-.15h6.87c.45 0 .67-.54.35-.85L5.5 3.21Z"/>' +
      "</svg>";

    const ripple = document.createElement("div");
    ripple.className = "__rec-ripple";
    ripple.setAttribute("data-rec-overlay", "ripple");

    function ensureMounted() {
      injectStyle();
      const target = document.documentElement || document.body;
      if (!target) return;
      if (!cursor.isConnected) target.appendChild(cursor);
      if (!ripple.isConnected) target.appendChild(ripple);
    }
    ensureMounted();

    let lastX = window.innerWidth / 2;
    let lastY = window.innerHeight / 2;

    function setPos(x, y, pressed) {
      lastX = x; lastY = y;
      cursor.style.left = x + "px";
      cursor.style.top = y + "px";
      cursor.classList.add("is-visible");
      cursor.classList.toggle("is-pressed", !!pressed);
    }

    function fireRipple(x, y) {
      ripple.style.left = x + "px";
      ripple.style.top = y + "px";
      ripple.classList.remove("is-firing");
      void ripple.offsetWidth;
      ripple.classList.add("is-firing");
    }

    window.addEventListener("pointermove", (e) => setPos(e.clientX, e.clientY, false), true);
    window.addEventListener("pointerdown", (e) => {
      setPos(e.clientX, e.clientY, true);
      fireRipple(e.clientX, e.clientY);
    }, true);
    window.addEventListener("pointerup", (e) => setPos(e.clientX, e.clientY, false), true);

    window.__rec = {
      setPos,
      fireRipple,
      ensureMounted,
      getPos: () => ({ x: lastX, y: lastY }),
      version: "1.0.0-clean",
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
})();
