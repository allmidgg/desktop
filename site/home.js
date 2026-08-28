/* Small, dependency-free progressive enhancements for the platform page. */
(() => {
  const root = document.documentElement;
  const motionButton = document.querySelector(".am-motion");
  const motionLabel = document.querySelector("[data-motion-label]");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let savedPreference = null;
  try { savedPreference = localStorage.getItem("allmid-motion"); } catch { /* Storage may be disabled. */ }

  function setMotion(paused) {
    root.dataset.amMotion = paused ? "paused" : "running";
    motionButton?.setAttribute("aria-pressed", String(paused));
    if (motionLabel) motionLabel.textContent = paused ? "Motion paused" : "Pause motion";
  }
  setMotion(reduced.matches || savedPreference === "paused");
  if (motionButton) {
    motionButton.hidden = false;
    motionButton.addEventListener("click", () => {
      // Honour the OS preference; explain it in the control if it is enabled.
      if (reduced.matches) {
        motionLabel.textContent = "Reduced motion enabled";
        return;
      }
      const paused = root.dataset.amMotion !== "paused";
      savedPreference = paused ? "paused" : "running";
      setMotion(paused);
      try { localStorage.setItem("allmid-motion", savedPreference); } catch { /* Optional preference. */ }
    });
  }
  reduced.addEventListener("change", () => setMotion(reduced.matches || savedPreference === "paused"));
  document.addEventListener("visibilitychange", () => document.body.classList.toggle("am-inactive", document.hidden));

  const gameButtons = [...document.querySelectorAll("[data-game]")];
  gameButtons.forEach((button) => {
    button.addEventListener("click", () => {
      gameButtons.forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      document.querySelectorAll(".am-game-detail").forEach((panel) => {
        panel.hidden = panel.id !== "game-" + button.dataset.game;
      });
      const radar = document.querySelector(".am-radar");
      radar?.style.setProperty("--am-radar-color", button.style.getPropertyValue("--game-color"));
    });
  });

  const featureTabs = [...document.querySelectorAll("[data-feature]")];
  function selectFeature(button) {
    featureTabs.forEach((item) => {
      item.setAttribute("aria-selected", String(item === button));
      item.tabIndex = item === button ? 0 : -1;
    });
    document.querySelectorAll(".am-feature-panel").forEach((panel) => {
      panel.hidden = panel.id !== "feature-" + button.dataset.feature;
    });
  }
  featureTabs.forEach((button, index) => {
    button.addEventListener("click", () => selectFeature(button));
    button.addEventListener("keydown", (event) => {
      let next;
      if (event.key === "ArrowRight") next = (index + 1) % featureTabs.length;
      if (event.key === "ArrowLeft") next = (index + featureTabs.length - 1) % featureTabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = featureTabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      selectFeature(featureTabs[next]);
      featureTabs[next].focus();
    });
  });

  // Content is visible by default; a missed observer never hides the page.
  if ("IntersectionObserver" in window && !reduced.matches) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    }, { threshold: .12 });
    document.querySelectorAll(".am-reveal").forEach((element) => observer.observe(element));
  }
})();
