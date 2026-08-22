(function () {
  "use strict";

  var DATA = null;
  try {
    DATA = JSON.parse(document.getElementById("allmid-data").textContent);
  } catch (e) {
    return; /* static page stays exactly as rendered */
  }

  var LANE_LABEL = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bot", SUPPORT: "Support" };
  var LANE_FULL = { TOP: "Top lane", JUNGLE: "Jungle", MIDDLE: "Mid lane", BOTTOM: "Bot lane", SUPPORT: "Support" };

  var ES_ICON =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M12 12v4"/><path d="M12 8.5v.01"/></svg>';
  function emptyBlock(title, text, cta) {
    return '<div class="es"><span class="es-ic">' + ES_ICON + '</span><span class="es-t">' + title +
      '</span><p class="es-p">' + text + '</p><a class="btn btn-ghost btn-sm" href="#download">' + cta + "</a></div>";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function nf(n) { return n.toLocaleString("en-US"); }
  function step(wr) {
    if (wr < 47) return 1;
    if (wr < 49.5) return 2;
    if (wr < 52) return 3;
    if (wr < 55) return 4;
    if (wr < 58) return 5;
    return 6;
  }
  /* bar scale: 46% .. 62%, with a marker at the 50% line */
  function barPct(wr) {
    var p = ((wr - 46) / 16) * 100;
    return Math.max(3, Math.min(100, p)).toFixed(1);
  }
  function bar(wr) {
    var s = step(wr);
    return '<span class="bar"><i class="bar-s' + s + '" style="width:' + barPct(wr) + '%"></i>' +
      '<span class="tick" style="left:25%"></span></span>';
  }
  function laneIcon(lane) {
    return '<svg class="lane-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
      { TOP: '<path d="M4 20V4h16"/><path d="M8 16L18 6"/>',
        JUNGLE: '<path d="M12 21v-5"/><path d="M12 16c-4 0-7-3-7-7 4 0 7 3 7 7z"/><path d="M12 16c4 0 7-3 7-7-4 0-7 3-7 7z"/>',
        MIDDLE: '<path d="M4 20L20 4"/><path d="M14 4h6v6"/>',
        BOTTOM: '<path d="M20 4v16H4"/><path d="M16 8L6 18"/>',
        SUPPORT: '<path d="M12 20s-7-4.4-7-9a4 4 0 017-2.6A4 4 0 0119 11c0 4.6-7 9-7 9z"/>' }[lane] +
      "</svg>";
  }

  /* ---------------- champion explorer ---------------- */
  var detail = document.getElementById("champ-detail");
  var grid = document.getElementById("champ-grid");
  var search = document.getElementById("champ-search");
  var counter = document.getElementById("champ-count");
  var noHits = document.getElementById("champ-nohits");

  function renderDetail(c) {
    var artHTML =
      '<img src="img/champions/splash/' + c.id + '.jpg" width="640" height="360" alt="' + esc(c.name) + ' splash art (Classic Jade art)">' +
      '<div class="detail-art-txt">' +
        '<div class="detail-name">' + esc(c.name) + "</div>" +
        '<div class="detail-roles">' +
          c.roles.map(function (r) { return '<span class="role">' + esc(r) + "</span>"; }).join("") +
          '<span class="role id">ID ' + c.cid + "</span>" +
        "</div>" +
      "</div>";

    var laneHTML;
    if (c.lanes.length) {
      laneHTML = '<div class="col-key"><span>Lane</span><span></span><span>Win rate</span><span>Games</span></div>' +
        '<div class="lane-rows">' + c.lanes.map(function (l) {
        return '<div class="lane-row">' +
          '<span class="lane-tag">' + laneIcon(l.lane) + LANE_LABEL[l.lane] +
            ' <span class="rank-pill">#' + l.rank + "</span></span>" +
          bar(l.wr) +
          '<span class="wr wr-s' + step(l.wr) + '">' + l.wr.toFixed(1) + "%</span>" +
          '<span class="sub">' + nf(l.games) + "</span>" +
        "</div>";
      }).join("") + "</div>" +
        '<p class="lane-foot">Top 10 in <b>' + c.lanes.length + "</b> of 5 lanes &middot; strongest in <b>" +
        LANE_FULL[c.lanes[0].lane] + "</b> at <b>" + c.lanes[0].wr.toFixed(1) + "%</b></p>";
    } else if (c.laneGames) {
      laneHTML = '<p class="empty-note"><b>' + esc(c.name) + "</b> is played mostly in <b>" +
        LANE_LABEL[c.mainLane] + "</b> &mdash; " + nf(c.laneGames) + " lane games out of " + nf(c.totalGames) +
        " total &mdash; but does not reach the top&nbsp;10 by win rate there, so no lane row is published in this sample. " +
        'The desktop app ranks all ' + DATA.totals.champions + " champions in every lane.</p>";
    } else {
      laneHTML = emptyBlock(
        "Not in this public cut",
        "This page publishes the top&nbsp;10 per lane. <b>" + esc(c.name) + "</b> is in the dataset &mdash; all " +
          DATA.totals.champions + " champions are &mdash; but does not appear in those ten.",
        "See the full table"
      );
    }

    var muHTML, muTitle;
    if (c.counters && c.counters.length) {
      muTitle = "Worst matchups";
      muHTML = '<div class="mu-rows">' + c.counters.map(function (m) {
        return '<div class="mu-row">' +
          '<img src="img/champions/icon/' + m.id + '.png" width="128" height="128" alt="' + esc(m.name) + '" loading="lazy">' +
          '<span class="mu-mid"><span class="mu-top"><span class="mu-name">' + esc(m.name) + "</span>" +
            '<span class="mu-games">' + nf(m.games) + "g</span></span>" + bar(m.wr) + "</span>" +
          '<span class="mu-wr wr-s' + step(m.wr) + '">' + m.wr.toFixed(1) + "%</span>" +
        "</div>";
      }).join("") + "</div>";
    } else if (c.beats && c.beats.length) {
      muTitle = "Wins into";
      muHTML = '<div class="mu-rows">' + c.beats.map(function (m) {
        return '<div class="mu-row">' +
          '<img src="img/champions/icon/' + m.id + '.png" width="128" height="128" alt="' + esc(m.name) + '" loading="lazy">' +
          '<span class="mu-mid"><span class="mu-top"><span class="mu-name">' + esc(m.name) + "</span>" +
            '<span class="mu-games">' + nf(m.games) + "g</span></span>" + bar(m.wr) + "</span>" +
          '<span class="mu-wr wr-s' + step(m.wr) + '">' + m.wr.toFixed(1) + "%</span>" +
        "</div>";
      }).join("") + "</div>";
    } else {
      muTitle = "Matchups";
      muHTML = emptyBlock(
        "Matchups live in the app",
        "This page shows the twelve most-played champions head to head. AllMid reads <b>" + esc(c.name) +
          "</b>'s lane opponent straight out of champion select and pulls the matchup there.",
        "Download AllMid"
      );
    }

    detail.innerHTML =
      '<div class="detail-grid">' +
        '<div class="detail-art">' + artHTML + "</div>" +
        '<div class="detail-col"><h4>Lane performance <span class="n">smoothed win rate, prior 20</span></h4>' + laneHTML + "</div>" +
        '<div class="detail-col mu"><h4>' + muTitle + ' <span class="n">head to head</span></h4>' + muHTML + "</div>" +
      "</div>";
  }

  function select(id, focus) {
    var c = DATA.champions[id];
    if (!c) return;
    var btns = grid.querySelectorAll(".champ-btn");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", btns[i].getAttribute("data-id") === String(id) ? "true" : "false");
    }
    renderDetail(c);
    if (focus) {
      var b = grid.querySelector('.champ-btn[data-id="' + id + '"]');
      if (b) b.focus();
    }
  }

  if (grid && detail) {
    grid.addEventListener("click", function (ev) {
      var b = ev.target.closest(".champ-btn");
      if (b) select(parseInt(b.getAttribute("data-id"), 10), false);
    });

    if (search) {
      search.disabled = false;
      search.placeholder = "Search " + DATA.totals.champions + " champions…";
      search.addEventListener("input", function () {
        var q = search.value.trim().toLowerCase();
        var btns = grid.querySelectorAll(".champ-btn");
        var shown = 0;
        for (var i = 0; i < btns.length; i++) {
          var hit = !q || btns[i].getAttribute("data-name").indexOf(q) !== -1;
          btns[i].classList.toggle("is-hidden", !hit);
          if (hit) shown++;
        }
        if (counter) counter.textContent = shown === btns.length ? String(btns.length) : shown + " / " + btns.length;
        if (noHits) noHits.classList.toggle("on", shown === 0);
      });
    }
  }

  /* ---------------- tier list tabs ---------------- */
  var tabsBox = document.getElementById("lane-tabs");
  var panelsBox = document.getElementById("lane-panels");
  if (tabsBox && panelsBox) {
    var panels = panelsBox.querySelectorAll(".lane-panel");
    var tabs = tabsBox.querySelectorAll(".tab");
    /* only hide once we know we can also reveal */
    if (panels.length && tabs.length === panels.length) {
      panelsBox.classList.add("js-tabs");
      tabsBox.hidden = false;
      var setLane = function (lane) {
        for (var i = 0; i < panels.length; i++) {
          panels[i].hidden = panels[i].getAttribute("data-lane") !== lane;
        }
        for (var j = 0; j < tabs.length; j++) {
          tabs[j].setAttribute("aria-selected", tabs[j].getAttribute("data-lane") === lane ? "true" : "false");
        }
      };
      tabsBox.addEventListener("click", function (ev) {
        var t = ev.target.closest(".tab");
        if (t) setLane(t.getAttribute("data-lane"));
      });
      setLane("MIDDLE");
    }
  }

  /* ---------------- animation safety net ----------------
     The entry animation is pure CSS and completes on its own; this only
     strips the hook afterwards so no element can ever be left mid-state. */
  window.addEventListener("load", function () {
    setTimeout(function () {
      var els = document.querySelectorAll(".reveal");
      for (var i = 0; i < els.length; i++) els[i].classList.remove("reveal");
    }, 1500);
  });
})();
