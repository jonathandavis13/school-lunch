#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import sys
from collections import defaultdict
from typing import Any, Dict, List, Optional, Tuple

import requests
import xml.etree.ElementTree as ET

BUILDING_ID = "d76afdbb-caa8-ed11-8e6a-c150c5c7a01a"
DISTRICT_ID = "9fd1237e-53a6-ed11-8e69-985645bc2745"
BASE_URL = "https://api.linqconnect.com/api/FamilyMenu"

# Case-insensitive exact matches to skip
EXCLUDE = {
  "Diced Peach Cup", 
  "Diced Tomato & Lettuce",
  "Fat Free Chocolate Milk",
  "Fresh Gala Apples",
  "Fresh Peach",
  "Ham Chef Salad HS",
  "Housemade Italian Dressing",
  "Lowfat 1% Milk",
  "Mandarin oranges",
  "Ranch Dressing",
  "Salsa",
  "Strawberry Milk",
  "Street Corn",
  "Taco Salad",
  "Veggie Chef Salad",
  "Veggie Chef Salad HS",
  "Yogurt Plate w/Mozz Stick",
  "Chilled Peaches",
  "Housemade Italian Dressing",
  "Lowfat 1% Milk",
  "Ranch Dressing",
  "Strawberry Milk",
  "Yogurt Plate w/Mozz Stick",
  "Chicken Caesar Salad",
  "Caesar Dressing",
  "Coleslaw",
  "Comeback Sauce",
  "Fresh Green Pears",
  "Ketchup",
  "Mustard",
  "PBJ Plate w/Mozz Stick",
  "Roasted Red Potatoes",
  "Steamed Mixed Veggies",
  "Fresh Bananas",
  "Mayonnaise",
  "Oven Baked French Fries",
  "Pineapple Tidbits",
  "Sunflower Seeds",
  "Veggie Burger",
  "Veggie Burger on Bun",
  "Tomato Cucumber Salad",
}

def mdy(d: dt.date) -> str:
    return f"{d.month}-{d.day}-{d.year}"

def dow_mdy(d: dt.date) -> str:
    return d.strftime("%A, %b %#d, %Y") if sys.platform.startswith("win") else d.strftime("%A, %b %-d, %Y")

def parse_date_from_any(s: str) -> Optional[dt.date]:
    if not isinstance(s, str):
        return None
    s = s.strip()
    # Try ISO first
    try:
        return dt.date.fromisoformat(s[:10])
    except Exception:
        pass
    # Try m/d/yyyy or m-d-yyyy
    for sep in ("/", "-"):
        try:
            m, d, y = s.split(sep)
            return dt.date(int(y), int(m), int(d))
        except Exception:
            pass
    return None

def fetch_range(start: dt.date, end: dt.date) -> Tuple[str, Optional[Dict[str, Any]], Optional[ET.Element]]:
    """
    Returns: (raw_text, json_obj_or_None, xml_root_or_None)
    We ask for JSON, but gracefully handle XML (the API often responds with XML).
    """
    params = {
        "buildingId": BUILDING_ID,
        "districtId": DISTRICT_ID,
        "startDate": mdy(start),
        "endDate": mdy(end),
    }
    headers = {"Accept": "application/json, text/xml, application/xml;q=0.9, */*;q=0.8"}
    r = requests.get(BASE_URL, params=params, headers=headers, timeout=30)
    r.raise_for_status()
    raw = r.text

    # Try JSON first
    try:
        data = r.json()
        if isinstance(data, dict) and data:
            return raw, data, None
    except Exception:
        pass

    # Fallback to XML
    try:
        root = ET.fromstring(raw)
        return raw, None, root
    except Exception:
        # Neither JSON nor XML? Raise helpful error.
        raise RuntimeError("Unexpected response format (not JSON/XML).")

def extract_from_json(data: Dict[str, Any], meal_session: str) -> List[Tuple[dt.date, str]]:
    out: List[Tuple[dt.date, str]] = []
    sessions = data.get("FamilyMenuSessions") or []
    for session in sessions:
        serving = (session.get("ServingSession") or "").strip()
        # Fallback: allow match if a MenuPlanName contains the meal
        plan_names = [ (p.get("MenuPlanName") or "") for p in (session.get("MenuPlans") or []) ]
        if meal_session.lower() != serving.lower() and not any(meal_session.lower() in n.lower() for n in plan_names):
            continue

        for plan in (session.get("MenuPlans") or []):
            for day in (plan.get("Days") or []):
                day_date = None
                for dk in ("Date", "ServiceDate", "MenuDate", "date"):
                    if dk in day:
                        day_date = parse_date_from_any(day[dk])
                        if day_date:
                            break
                if not day_date:
                    continue

                for meal in (day.get("MenuMeals") or []):
                    for cat in (meal.get("RecipeCategories") or []):
                        for rec in (cat.get("Recipes") or []):
                            name = None
                            for rk in ("RecipeName", "DisplayName", "ItemName", "Name"):
                                if isinstance(rec.get(rk), str):
                                    name = rec[rk].strip()
                                    break
                            if name:
                                out.append((day_date, name))
    return out

def extract_from_xml(root: ET.Element, meal_session: str) -> List[Tuple[dt.date, str]]:
    ns_any = ".//{*}"
    out: List[Tuple[dt.date, str]] = []

    for session in root.findall(ns_any + "FamilyMenuSession"):
        serving_el = session.find(ns_any + "ServingSession")
        serving = (serving_el.text.strip() if serving_el is not None and serving_el.text else "")
        # Fallback on plan names if ServingSession missing/mismatched
        plan_name_hits = False
        for plan in session.findall(ns_any + "MenuPlans/" + ns_any + "MenuPlan"):
            mpn = plan.find(ns_any + "MenuPlanName")
            if mpn is not None and mpn.text and meal_session.lower() in mpn.text.lower():
                plan_name_hits = True

        if meal_session.lower() != serving.lower() and not plan_name_hits:
            continue

        for plan in session.findall(ns_any + "MenuPlans/" + ns_any + "MenuPlan"):
            for day in plan.findall(ns_any + "Days/" + ns_any + "Day"):
                dtxt = None
                for dk in ("Date", "ServiceDate", "MenuDate"):
                    el = day.find(ns_any + dk)
                    if el is not None and el.text:
                        dtxt = el.text
                        break
                day_date = parse_date_from_any(dtxt) if dtxt else None
                if not day_date:
                    continue

                for meal in day.findall(ns_any + "MenuMeals/" + ns_any + "MenuMeal"):
                    for cat in meal.findall(ns_any + "RecipeCategories/" + ns_any + "RecipeCategory"):
                        for rec in cat.findall(ns_any + "Recipes/" + ns_any + "Recipe"):
                            name_el = None
                            for rk in ("RecipeName", "DisplayName", "ItemName", "Name"):
                                cand = rec.find(ns_any + rk)
                                if cand is not None and cand.text:
                                    name_el = cand
                                    break
                            if name_el is not None:
                                out.append((day_date, name_el.text.strip()))
    return out

def build_dates(start: Optional[str], days: int, skip_weekends: bool) -> List[dt.date]:
    start_date = dt.date.fromisoformat(start) if start else dt.date.today()
    dates: List[dt.date] = []
    d = start_date
    while len(dates) < days:
        if skip_weekends and d.weekday() >= 5:
            d += dt.timedelta(days=1)
            continue
        dates.append(d)
        d += dt.timedelta(days=1)
    return dates

def main():
    ap = argparse.ArgumentParser(description="Print school lunch menu for next N days.")
    ap.add_argument("--days", type=int, default=5, help="Number of calendar days (default 5)")
    ap.add_argument("--start", type=str, help="Start date YYYY-MM-DD (default: today)")
    ap.add_argument("--skip-weekends", action="store_true", help="Skip Sat/Sun")
    ap.add_argument("--meal", type=str, default="Lunch", help="ServingSession to include (default: Lunch)")
    args = ap.parse_args()

    dates = build_dates(args.start, args.days, args.skip_weekends)
    start_q, end_q = min(dates), max(dates)

    try:
        raw, jdata, xroot = fetch_range(start_q, end_q)
    except Exception as e:
        print(f"Fetch error: {e}", file=sys.stderr)
        sys.exit(1)

    # Save raw for debugging
    with open("familymenu_raw.txt", "w", encoding="utf-8") as f:
        f.write(raw)

    if jdata is not None:
        items = extract_from_json(jdata, meal_session=args.meal)
    elif xroot is not None:
        items = extract_from_xml(xroot, meal_session=args.meal)
    else:
        print("Could not parse response.", file=sys.stderr)
        sys.exit(2)

    # Keep only wanted dates & dedupe
    wanted = set(dates)
    by_day: Dict[dt.date, List[str]] = defaultdict(list)
    seen: Dict[Tuple[dt.date, str], bool] = {}
    for d, name in sorted(items, key=lambda x: (x[0], x[1].lower())):
        if d not in wanted:
            continue
        key = (d, name.lower())
        if not seen.get(key):
            by_day[d].append(name)
            seen[key] = True

    # Apply exclusions
    exc_lower = {x.lower() for x in EXCLUDE}
    printed: Dict[dt.date, List[str]] = {}
    excluded_found: Dict[dt.date, List[str]] = {}
    for d in dates:
        printed[d] = []
        excluded_found[d] = []
        for r in by_day.get(d, []):
            if r.lower() in exc_lower:
                excluded_found[d].append(r)
            else:
                printed[d].append(r)

    # Console output
    print("\n=======", args.meal.strip().title(), "Menu =======\n")
    for d in dates:
        print(dow_mdy(d))
        if printed[d]:
            for r in printed[d]:
                print(f"  - {r}")
        else:
            print("  (no items found)")
        print()

    # print("======= Excluded (encountered & skipped) =======\n")
    # any_exc = False
    # for d in dates:
    #     if excluded_found[d]:
    #         any_exc = True
    #         print(dow_mdy(d))
    #         for r in sorted(set(excluded_found[d]), key=str.lower):
    #             print(f"  - {r}")
    #         print()
    # if not any_exc:
    #     print("(None encountered from your EXCLUDE list)\n")

    # CSVs
    import csv
    with open("menu.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "DayOfWeek", "RecipeName"])
        for d in dates:
            for r in printed[d]:
                w.writerow([d.isoformat(), d.strftime("%A"), r])

    with open("excluded.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Date", "DayOfWeek", "RecipeName"])
        for d in dates:
            for r in sorted(set(excluded_found[d]), key=str.lower):
                w.writerow([d.isoformat(), d.strftime("%A"), r])

    # Friendly tip if nothing showed up
    total = sum(len(v) for v in printed.values())
    if total == 0:
        print(
            "No items printed. Check familymenu_raw.txt to confirm ServingSession labels "
            f"and your --meal='{args.meal}'. If your district uses a different term, try --meal Breakfast/Dinner.",
            file=sys.stderr,
        )

if __name__ == "__main__":
    main()
