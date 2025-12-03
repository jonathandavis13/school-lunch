// test-lunch-menu.mjs
//
// Standalone Node.js script to test JD's LINQConnect lunch logic
// without Scriptable / widgets. Runs with:  node test-lunch-menu.mjs

// ── Config ──────────────────────────────────────────────────────────────
const CONFIG = {
  buildingId: "d76afdbb-caa8-ed11-8e6a-c150c5c7a01a",
  districtId: "9fd1237e-53a6-ed11-8e69-985645bc2745",
  mealSession: "Lunch",          // ServingSession to include
  daysToShow: 5,                 // number of school days to display
  skipWeekends: true,            // only show Mon–Fri
  maxItemsPerDay: 3,             // just used for display in this script
  bullet: "•",
  exclude: [
    // "Milk", "Chocolate Milk", "Assorted Fruit", "Ketchup", "Mustard", "Mayo"
  ],
  // Substring patterns (case-insensitive) to treat as ignored entrees
  ignorePatterns: [
    "PBJ","corndog","Yogurt","Chicken Shawarma WG","Tikka","soup"
  ],
};

// ── Utilities (adapted from your Scriptable code) ───────────────────────
function fmtAPI(d) { // M-D-YYYY (no leading zeros)
  return `${d.getMonth() + 1}-${d.getDate()}-${d.getFullYear()}`;
}

function ymd(d) { // YYYY-MM-DD
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function niceDate(d) {
  // Approximate Scriptable's DateFormatter("EEE, MMM d")
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(d);
}

function isWeekend(d) {
  const w = d.getDay();
  return w === 0 || w === 6;
}

function nextSchoolDays(n, skipWeekends = true) {
  const out = [];
  let d = new Date();
  while (out.length < n) {
    if (!(skipWeekends && isWeekend(d))) out.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

function uniq(arr) {
  return [...new Set(arr)];
}

function lowerSet(arr) {
  return new Set(arr.map((s) => s.toLowerCase()));
}

// ── Fetch LINQConnect (JSON only; they return JSON for this endpoint) ──
async function fetchRange(start, end) {
  const base = "https://api.linqconnect.com/api/FamilyMenu";
  const url = `${base}?buildingId=${encodeURIComponent(
    CONFIG.buildingId
  )}&districtId=${encodeURIComponent(
    CONFIG.districtId
  )}&startDate=${encodeURIComponent(fmtAPI(start))}&endDate=${encodeURIComponent(
    fmtAPI(end)
  )}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `FamilyMenu request failed: ${res.status} ${res.statusText}\n${text}`
    );
  }

  return res.json();
}

// ── Extract (date → [recipe names]) from JSON (same logic as widget) ───
function extractFromJSON(data, mealSession, wantedDates) {
  const out = new Map(); // ymd -> [names]
  const sessions = data?.FamilyMenuSessions || [];
  for (const session of sessions) {
    const serving = (session?.ServingSession || "").toLowerCase();
    const planNames = (session?.MenuPlans || []).map((p) =>
      (p?.MenuPlanName || "").toLowerCase()
    );
    const lowerMeal = mealSession.toLowerCase();

    const mealOk =
      serving === lowerMeal || planNames.some((n) => n.includes(lowerMeal));
    if (!mealOk) continue;

    for (const plan of session.MenuPlans || []) {
      for (const day of plan.Days || []) {
        let dtxt = day?.Date || day?.ServiceDate || day?.MenuDate || "";
        if (!dtxt) continue;

        const d = new Date(dtxt); // Date parses ISO or yyyy-mm-ddTHH:mm
        const key = ymd(d);
        if (!wantedDates.has(key)) continue;

        for (const meal of day.MenuMeals || []) {
          for (const cat of meal.RecipeCategories || []) {
            const catName = (
              cat?.RecipeCategoryName ||
              cat?.CategoryName ||
              cat?.Name ||
              cat?.DisplayName ||
              ""
            )
              .toString()
              .toLowerCase();

            // Only include recipes from the "Main Entree" category
            if (!catName.includes("main entree")) continue;

            for (const rec of cat.Recipes || []) {
              const name =
                rec?.RecipeName ||
                rec?.DisplayName ||
                rec?.ItemName ||
                rec?.Name;
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

// ── Main test harness ───────────────────────────────────────────────────
async function main() {
  const days = nextSchoolDays(CONFIG.daysToShow, CONFIG.skipWeekends);
  const start = days[0];
  const end = days[days.length - 1];
  const wanted = new Set(days.map(ymd));

  const json = await fetchRange(start, end);
  let byDate = extractFromJSON(json, CONFIG.mealSession, wanted);

  // Normalize, dedupe, exclude (same as widget)
  const excl = lowerSet(CONFIG.exclude);
  const ignorePatterns = (CONFIG.ignorePatterns || []).map((p) => p.toLowerCase());
  const excludedCollected = new Set();
  for (const k of Array.from(byDate.keys())) {
    const list = uniq(byDate.get(k).map((s) => s.trim()));
    const filtered = list.filter((s) => {
      const low = s.toLowerCase();
      if (excl.has(low)) {
        excludedCollected.add(s);
        return false;
      }
      // check ignore substring patterns
      for (const pat of ignorePatterns) {
        if (low.includes(pat)) {
          excludedCollected.add(s);
          return false;
        }
      }
      return true;
    });
    byDate.set(k, filtered);
  }

  // Console output: roughly what your widget will show
  console.log(`\n${CONFIG.mealSession} • Next ${CONFIG.daysToShow} school days\n`);

  for (const d of days) {
    const key = ymd(d);
    const pretty = niceDate(d);
    const items = byDate.get(key) || [];

    console.log(`${pretty} (${key})`);
    if (!items.length) {
      console.log("  (no lunch items)\n");
      continue;
    }

    const shown = items.slice(0, CONFIG.maxItemsPerDay);
    const more = Math.max(0, items.length - shown.length);

    for (const name of shown) {
      console.log(`  ${CONFIG.bullet} ${name}`);
    }
    if (more > 0) {
      console.log(`  +${more} more`);
    }
    console.log("");
  }

  // Print ignored entrees found during normalization
//   if (excludedCollected.size) {
//     console.log("Ignored entrees (matched by exclude or ignorePatterns):");
//     for (const v of Array.from(excludedCollected).sort()) console.log(`  - ${v}`);
//     console.log("");
//   }
}

main().catch((err) => {
  console.error("Error while testing lunch menu:", err);
});
