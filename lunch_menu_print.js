// Lunch Menu Widget (LINQConnect → Scriptable)
// JD's district/building prefilled. Shows next 5 school days (skip weekends).
// Place as a Medium widget for best results.
//
// ── Config ────────────────────────────────────────────────────────────────────
const CONFIG = {
    buildingId: "d76afdbb-caa8-ed11-8e6a-c150c5c7a01a",
    districtId: "9fd1237e-53a6-ed11-8e69-985645bc2745",
    mealSession: "Lunch",          // ServingSession to include
    daysToShow: 5,                 // number of school days to display
    skipWeekends: true,            // only show Mon–Fri    maxItemsPerDay: 3,             // visual cap per day (still fetches all)
    bullet: "•",                   // bullet for recipe lines
    // Items to hide completely (case-insensitive exact matches):
    exclude: [
      // "Milk", "Chocolate Milk", "Assorted Fruit", "Ketchup", "Mustard", "Mayo"
    ],
    // Substring patterns (case-insensitive) to treat as ignored entrees
    ignorePatterns: [
      "PBJ","corndog","Yogurt","Chicken Shawarma WG","Tikka","soup"
    ],
    // Styling
    fonts: {
      header: Font.semiboldSystemFont(12),
      day:    Font.semiboldSystemFont(12),
      items:  Font.systemFont(11),
      foot:   Font.systemFont(9),
    },
    colors: {
      header: Color.gray(),
      day:    Color.dynamic(new Color("#111111"), new Color("#ffffff")),
      items:  Color.dynamic(new Color("#222222"), new Color("#eaeaea")),
      foot:   Color.gray(),
    },
    refreshHours: 4                // widget refresh hint
  };
  // ─────────────────────────────────────────────────────────────────────────────
  
  /** Utilities **/
  function fmtAPI(d) { // M-D-YYYY (no leading zeros)
    return `${d.getMonth()+1}-${d.getDate()}-${d.getFullYear()}`
  }
  function ymd(d) { // YYYY-MM-DD
    const mm = (d.getMonth()+1).toString().padStart(2,"0");
    const dd = d.getDate().toString().padStart(2,"0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  }
  function niceDate(d) {
    const fmt = new DateFormatter();
    fmt.dateFormat = "EEE, MMM d";
    return fmt.string(d);
  }
  function isWeekend(d) { const w = d.getDay(); return w === 0 || w === 6; }
  function nextSchoolDays(n, skipWeekends = true) {
    const out = [];
    let d = new Date();
    while (out.length < n) {
      if (!(skipWeekends && isWeekend(d))) out.push(new Date(d));
      d.setDate(d.getDate()+1);
    }
    return out;
  }
  function uniq(arr) { return [...new Set(arr)]; }
  function lowerSet(arr) { return new Set(arr.map(s => s.toLowerCase())); }
  function truncate(str, max) { return (str.length <= max) ? str : str.slice(0, max-1) + "…"; }
  
  // XML helpers (Scriptable's XMLParser keeps node.name / node.text / node.children)
  function childrenByName(node, name) {
    if (!node || !node.children) return [];
    return node.children.filter(c => (c.name || "").toLowerCase().endsWith(name.toLowerCase()));
  }
  function childByName(node, name) {
    const xs = childrenByName(node, name);
    return xs.length ? xs[0] : null;
  }
  function text(node) { return (node && typeof node.text === "string") ? node.text.trim() : ""; }
  
  /** Fetch LINQConnect for date range, tolerate JSON or XML **/
  async function fetchRange(start, end) {
    const base = "https://api.linqconnect.com/api/FamilyMenu";
    const url = `${base}?buildingId=${encodeURIComponent(CONFIG.buildingId)}&districtId=${encodeURIComponent(CONFIG.districtId)}&startDate=${encodeURIComponent(fmtAPI(start))}&endDate=${encodeURIComponent(fmtAPI(end))}`;
  
    const req = new Request(url);
    req.method = "GET";
    req.headers = { "Accept": "application/json, text/xml, application/xml;q=0.9, */*;q=0.8" };
  
    // Try JSON first
    try { return { json: await req.loadJSON(), xml: null }; }
    catch (_) {}
  
    // Fallback to text → XML
    const raw = await req.loadString();
    try {
      const root = new XMLParser(raw).parse();
      return { json: null, xml: root };
    } catch (e) {
      throw new Error("FamilyMenu: Unexpected response format (not JSON/XML).");
    }
  }
  
  /** Extract (date → [recipe names]) from JSON **/
  function extractFromJSON(data, mealSession, wantedDates) {
    const out = new Map(); // ymd -> [names]
    const sessions = data?.FamilyMenuSessions || [];
    for (const session of sessions) {
      const serving = (session?.ServingSession || "").toLowerCase();
      const planNames = (session?.MenuPlans || []).map(p => (p?.MenuPlanName || "").toLowerCase());
      const mealOk = serving === mealSession.toLowerCase() || planNames.some(n => n.includes(mealSession.toLowerCase()));
      if (!mealOk) continue;
  
      for (const plan of (session.MenuPlans || [])) {
        for (const day of (plan.Days || [])) {
          // Date key on Day may be Date/ServiceDate/MenuDate
          let dtxt = day?.Date || day?.ServiceDate || day?.MenuDate || "";
          if (!dtxt) continue;
          const d = new Date(dtxt); // Date parses ISO or yyyy-mm-ddTHH:mm
          const key = ymd(d);
          if (!wantedDates.has(key)) continue;
  
          for (const meal of (day.MenuMeals || [])) {
            for (const cat of (meal.RecipeCategories || [])) {
              const catName = (cat?.RecipeCategoryName || cat?.CategoryName || cat?.Name || cat?.DisplayName || "").toString().toLowerCase();
              // Only include recipes from the "Main Entree" category
              if (!catName.includes("main entree")) continue;
              for (const rec of (cat.Recipes || [])) {
                const name = rec?.RecipeName || rec?.DisplayName || rec?.ItemName || rec?.Name;
                if (name) {
                  if (!out.has(key)) out.set(key, []);
                  out.get(key).push(name.trim());
                }
              }
            }
          }
        }
      }
    }
    return out;
  }
  
  /** Extract (date → [recipe names]) from XML **/
  function extractFromXML(root, mealSession, wantedDates) {
    const out = new Map();
    const sessions = childrenByName(root, "FamilyMenuSession");
    for (const s of sessions) {
      const serving = text(childByName(s, "ServingSession")).toLowerCase();
      // Fallback to MenuPlanName if ServingSession missing/mismatch
      let mealOk = serving === mealSession.toLowerCase();
      if (!mealOk) {
        const plans = childrenByName(childByName(s, "MenuPlans"), "MenuPlan");
        const hit = plans.some(p => text(childByName(p, "MenuPlanName")).toLowerCase().includes(mealSession.toLowerCase()));
        if (hit) mealOk = true;
      }
      if (!mealOk) continue;
  
      const plans = childrenByName(childByName(s, "MenuPlans"), "MenuPlan");
      for (const p of plans) {
        const days = childrenByName(childByName(p, "Days"), "Day");
        for (const day of days) {
          const dtxt =
            text(childByName(day, "Date")) ||
            text(childByName(day, "ServiceDate")) ||
            text(childByName(day, "MenuDate"));
          if (!dtxt) continue;
          const d = new Date(dtxt);
          const key = ymd(d);
          if (!wantedDates.has(key)) continue;
  
          const meals = childrenByName(childByName(day, "MenuMeals"), "MenuMeal");
          for (const m of meals) {
            const cats = childrenByName(childByName(m, "RecipeCategories"), "RecipeCategory");
            for (const c of cats) {
                const catName = (text(childByName(c, "RecipeCategoryName")) || text(childByName(c, "CategoryName")) || text(childByName(c, "Name")) || "").toLowerCase();
                // Only include recipes from the "Main Entree" category
                if (!catName.includes("main entree")) continue;
                const recs = childrenByName(childByName(c, "Recipes"), "Recipe");
                for (const r of recs) {
                const nameNode =
                  childByName(r, "RecipeName") ||
                  childByName(r, "DisplayName") ||
                  childByName(r, "ItemName") ||
                  childByName(r, "Name");
                const name = text(nameNode);
                if (name) {
                  if (!out.has(key)) out.set(key, []);
                  out.get(key).push(name);
                }
              }
            }
          }
        }
      }
    }
    return out;
  }
  
  /** Main: fetch → extract → build widget **/
  async function run() {
    const days = nextSchoolDays(CONFIG.daysToShow, CONFIG.skipWeekends);
    const start = days[0];
    const end   = days[days.length - 1];
    const wanted = new Set(days.map(ymd));
  
    const { json, xml } = await fetchRange(start, end);
    let byDate = json ? extractFromJSON(json, CONFIG.mealSession, wanted)
                      : extractFromXML(xml,  CONFIG.mealSession, wanted);
  
    // Normalize, dedupe, exclude
    const excl = lowerSet(CONFIG.exclude);
    const ignorePatterns = (CONFIG.ignorePatterns || []).map(p => p.toLowerCase());
    for (const k of Array.from(byDate.keys())) {
      const list = uniq(byDate.get(k).map(s => s.trim()));
      const filtered = list.filter(s => {
        const low = s.toLowerCase();
        if (excl.has(low)) return false;
        // check ignore substring patterns
        for (const pat of ignorePatterns) {
          if (low.includes(pat)) return false;
        }
        return true;
      });
      byDate.set(k, filtered);
    }
  
    // Build widget
    const w = new ListWidget();
    w.setPadding(10, 12, 10, 12);
  
    // Subtle gradient
    const startColor = new Color("#0a84ff", 0.10);
    const endColor = new Color("#30d158", 0.10);
    const g = new LinearGradient();
    g.colors = [startColor, endColor];
    g.locations = [0, 1];
    g.startPoint = new Point(0, 0);
    g.endPoint = new Point(1, 1);
    w.backgroundGradient = g;
  
    // Header
    const h = w.addStack();
    h.centerAlignContent();
    const tHeader = h.addText(`${CONFIG.mealSession} • Next ${CONFIG.daysToShow}`);
    tHeader.font = CONFIG.fonts.header;
    tHeader.textColor = CONFIG.colors.header;
    h.addSpacer();
  
    w.addSpacer(6);
  
    // Rows
    for (const d of days) {
      const key = ymd(d);
      const row = w.addStack();
      row.layoutHorizontally();
      row.topAlignContent();
  
      // Day label
      const left = row.addStack();
      left.size = new Size(78, 0); // fixed width for alignment
      const tDay = left.addText(niceDate(d));
      tDay.font = CONFIG.fonts.day;
      tDay.textColor = CONFIG.colors.day;
  
      row.addSpacer(6);
  
      // Items
      const items = byDate.get(key) || [];
      const shown = items.slice(0, CONFIG.maxItemsPerDay);
      const more = Math.max(0, items.length - shown.length);
  
      const right = row.addStack();
      right.layoutVertically();
  
      if (shown.length) {
        for (const name of shown) {
          const t = right.addText(`${CONFIG.bullet} ${name}`);
          t.font = CONFIG.fonts.items;
          t.textColor = CONFIG.colors.items;
        }
        if (more > 0) {
          const tMore = right.addText(`+${more} more`);
          tMore.font = CONFIG.fonts.items;
          tMore.textColor = CONFIG.colors.items;
        }
      } else {
        const tNone = right.addText("(no lunch items)");
        tNone.font = CONFIG.fonts.items;
        tNone.textColor = CONFIG.colors.items;
      }
  
      w.addSpacer(6);
    }
  
    // Footer
    const f = w.addStack();
    const tFoot = f.addText("Tap to open menu");
    tFoot.font = CONFIG.fonts.foot;
    tFoot.textColor = CONFIG.colors.foot;
  
    // Tap → open this week's LINQConnect range
    const url = `https://api.linqconnect.com/api/FamilyMenu?buildingId=${encodeURIComponent(CONFIG.buildingId)}&districtId=${encodeURIComponent(CONFIG.districtId)}&startDate=${encodeURIComponent(fmtAPI(start))}&endDate=${encodeURIComponent(fmtAPI(end))}`;
    w.url = url;
  
    // Refresh hint
    const next = new Date();
    next.setHours(next.getHours() + CONFIG.refreshHours);
    w.refreshAfterDate = next;
  
    if (config.runsInWidget) {
      Script.setWidget(w);
    } else {
      // Preview in app
      await w.presentMedium();
    }
    Script.complete();
  }
  
  await run();
  