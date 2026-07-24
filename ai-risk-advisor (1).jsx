import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  Shield, HeartPulse, Umbrella, Car, Activity, ShieldAlert, Wallet, Download,
  Pencil, Send, Sparkles, ChevronLeft, ChevronRight, ChevronDown, Check, Loader2,
  AlertTriangle, MessageCircle, LayoutDashboard, ListChecks, Coins, FlaskConical,
  Map as MapIcon, FileSearch, Heart, Baby, Home, Banknote, Briefcase, TrendingUp, Sunset,
  Users, Database, Settings, RefreshCw, FileText, X
} from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

/* ================================================================================
   AI PERSONAL RISK ADVISOR — v2 (white-label: set BRAND below)
   --------------------------------------------------------------------------------
   Single-file artifact, organised as modules. When migrating to a real repo,
   each banner below becomes a folder:

     §1 CONFIG            → src/config.ts
     §2 UTILS             → src/utils/
     §3 RULES ENGINE      → src/engine/        (covers, scores, premiums, budget,
                                                roadmap, life events, explainability)
     §4 API LAYER         → src/api/           (Claude, storage adapter, leads, Sheets)
     §5 HOOKS             → src/hooks/
     §6 UI PRIMITIVES     → src/components/ui/
     §7 FEATURES          → src/components/features/
     §8 PAGES             → src/pages/         (Advisor, Admin)
     §9 APP ROOT          → src/App.tsx
   ================================================================================ */

/* ============================== §1 CONFIG ===================================== */
const L = 100000; // ₹1 lakh
const CLAUDE_MODEL = "claude-sonnet-4-6";
const BRAND = "AI Risk Advisor"; // ← re-brand the entire app (header, report, prompts, disclaimers) by editing this one line
const ENGINE_VERSION = "3.1.0";        /* [§12] bump on any rules-engine change */
const RULES_VERSION = "2026-07-14";    /* [§12] date the rule set was last reviewed */
const CONSENT_VERSION = "1.1";         /* [§14] bump when consent/privacy text changes */

/* ============================== §2 UTILS ====================================== */
const fmt = (x) => {
  if (x == null || isNaN(x)) return "—";
  if (Math.abs(x) >= 10000000) {
    const cr = x / 10000000;
    return `₹${cr % 1 === 0 ? cr.toFixed(0) : cr.toFixed(1)} Cr`;
  }
  if (Math.abs(x) >= L) return `₹${Math.round(x / L)} L`;
  return `₹${Math.round(x).toLocaleString("en-IN")}`;
};
const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
const roundUp25L = (x) => Math.ceil(x / (25 * L)) * (25 * L);
const round25L = (x) => Math.max(25 * L, Math.round(x / (25 * L)) * (25 * L));
const round5L = (x) => Math.max(5 * L, Math.round(x / (5 * L)) * (5 * L)); /* [FIX F5] */
const newId = () => "REC-" + Date.now().toString(36).toUpperCase();
const hashStr = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return "h" + (h >>> 0).toString(36); };
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
/* [§4] tri-state: legacy booleans map cleanly so old stored leads stay readable */
const tri = (v) => (v === true || v === "yes") ? "yes" : (v === false || v === "no") ? "no" : "unknown";
const isYes = (v) => tri(v) === "yes";
const isUnknown = (v) => tri(v) === "unknown";
/* [§13] neutralise spreadsheet formula injection before any value leaves the app */
const sanitizeCell = (v) => { const t = String(v ?? ""); return /^[=+\-@\t\r]/.test(t) ? "'" + t : t; };
/* [§3] information completeness drives confidence — never a fake percentage of certainty */
function profileCompleteness(p) {
  const missing = []; let got = 0, total = 0;
  const chk = (label, ok) => { total++; if (ok) got++; else missing.push(label); };
  chk("age", num(p.age) >= 18); chk("annual income", num(p.incomeL) > 0); chk("monthly expenses", num(p.monthlyExp) > 0);
  chk("city", !!p.cityTier); chk("occupation", !!p.occupation); chk("marital status", !!p.marital);
  chk("parent's age", !p.parentsDep || num(p.parentAge) > 0);
  chk("motor policy status", p.vehicle === "none" || !!p.vehicleIns);
  chk("smoking/tobacco", !isUnknown(p.smoker)); chk("diabetes", !isUnknown(p.diabetes));
  chk("blood pressure", !isUnknown(p.bp)); chk("family history", !isUnknown(p.famHistory));
  chk("contact email", (p.email || "").includes("@")); chk("contact phone", (p.phone || "").length >= 10);
  return { pct: Math.round((got / total) * 100), missing };
}

/* ============================ §3 RULES ENGINE ================================= */

/* [P1][P5] Midpoint of an indicative premium band — premiumRange is hoisted below. */
function midCost(kind, cover, p, cLike) {
  const [lo, hi] = premiumRange(kind, cover, p, cLike);
  return Math.round((lo + hi) / 2);
}

/** Core cover computation — deterministic and auditable. Every line also emits
 *  explainability metadata: formula, confidence, alternative, risks. */
function computePlan(p) {
  const income = num(p.incomeL) * L;
  const loans = num(p.loansL) * L;
  const savings = num(p.savingsL) * L;
  const monthlyExp = num(p.monthlyExp);
  const age = num(p.age, 28);
  const kids = num(p.kids);
  const parentAge = num(p.parentAge);

  const married = p.marital === "married";
  const metro = p.cityTier === "metro";
  const selfEmployed = p.occupation !== "salaried";
  const hasDependents = p.spouseDep === "homemaker" || kids > 0 || p.parentsDep;
  /* [§4] tri-state: YES loads risk; UNKNOWN never silently becomes NO — it lowers confidence instead */
  const riskFactors = [p.smoker, p.diabetes, p.bp, p.famHistory].filter(isYes).length;
  const unknownFactors = [["smoking/tobacco", p.smoker], ["diabetes", p.diabetes], ["blood pressure", p.bp], ["family history", p.famHistory]].filter(([, v]) => isUnknown(v)).map(([n]) => n);
  const completeness = profileCompleteness(p); /* [§3] */

  /* ----- HEALTH — [P1] dynamic base + super top-up structure ----- */
  const floater = married || kids > 0;
  /* Layer 1 (base): sized to one typical hospitalisation in their city — this is also the deductible. */
  const healthBase = metro ? 10 * L : floater ? 7 * L : 5 * L;
  /* Total protection target: city × family × income × medical history (no hardcoded ₹10L+₹90L). */
  let healthTotal = floater ? (metro ? 50 * L : 30 * L) : (metro ? 25 * L : 15 * L);
  if (income >= 25 * L) healthTotal *= 2; else if (income >= 12 * L) healthTotal *= 1.5;
  if (riskFactors >= 2) healthTotal = Math.round(healthTotal * 1.5); else if (riskFactors === 1) healthTotal = Math.round(healthTotal * 1.25);
  healthTotal = Math.min(200 * L, Math.max(healthBase, Math.round(healthTotal / (5 * L)) * 5 * L));
  /* Structure decision: a top-up layer only earns its admin overhead above ~₹10L extra.
     Below that, a single traditional policy is simpler and roughly the same money. */
  const useTopUp = healthTotal - healthBase >= 10 * L;
  const healthTopUp = useTopUp ? healthTotal - healthBase : 0;
  const healthCover = healthTotal; // gap/score compare against total protection
  /* [P1] premium comparison: layered vs a flat policy of the same total size */
  const structCost = midCost("health", healthBase, p, { age }) + (useTopUp ? midCost("topup", healthTopUp, p, { age }) : 0);
  const flatCost = midCost("health", healthTotal, p, { age });
  const healthSave = useTopUp ? Math.max(0, flatCost - structCost) : 0;
  /* [P2] Parents: fresh senior policies get progressively harder — never promise availability at 70+. */
  let parentsPlan = 0, parentsMode = "none", parentsCorpus = 0;
  if (p.parentsDep && parentAge >= 55) {
    if (parentAge >= 70) {
      parentsMode = "senior-caution";           // co-pay, loadings, PED waiting, possible decline
      parentsPlan = 10 * L;                      // target *if* an insurer accepts — not guaranteed
      parentsCorpus = metro ? 20 * L : 15 * L;   // parallel self-funded medical corpus
    } else {
      parentsMode = "senior-plan";
      parentsPlan = parentAge >= 65 ? 15 * L : 10 * L;
    }
  }
  /* [P3] Port + enhance beats buy-new when a personal policy already exists (keeps served waiting periods). */
  const existingHealthL = num(p.covHealthL); /* [FIX F16] snapshot into plan — cards must not read live form state */
  const canPort = existingHealthL > 0;
  const parentsYoung = p.parentsDep && parentAge > 0 && parentAge < 55; /* [FIX F10] */
  const effHealthNow = existingHealthL * L + 0.5 * num(p.covEmpHealthL) * L;
  const healthGap = Math.max(0, healthCover - effHealthNow);
  const health = {
    cover: healthCover, base: healthBase, topUp: healthTopUp, deductible: useTopUp ? healthBase : 0,
    structure: useTopUp ? "topup" : "flat", save: healthSave, canPort, existingHealthL,
    flatCost, structCost, /* [§16] both options priced for the compare block */
    floater, parentsPlan, parentsMode, parentsCorpus, parentsYoung, parentAge,
    now: effHealthNow, gap: healthGap, priority: "High",
    meta: {
      formula: useTopUp
        ? `Total ${fmt(healthTotal)} = ${fmt(healthBase)} base (${metro ? "metro" : "non-metro"} hospitalisation floor, also the deductible) + ${fmt(healthTopUp)} super top-up. Layered structure ≈ ${fmt(structCost)}/yr vs ≈ ${fmt(flatCost)}/yr for a flat ${fmt(healthTotal)} policy → saves ≈ ${fmt(healthSave)}/yr. Drivers: city, ${floater ? "family floater" : "individual"}, income band${riskFactors ? ", medical history (+" + (riskFactors >= 2 ? "50" : "25") + "%)" : ""}. Employer cover weighted 50% (ends on job change).`
        : `${fmt(healthTotal)} single ${floater ? "family floater" : "individual"} policy — at this size a top-up layer adds paperwork without meaningful savings. Employer cover weighted 50%.`,
      confidence: parentsMode === "senior-caution" ? "Medium" : "High", /* [P2] senior underwriting uncertainty */
      confWhy: parentsMode === "senior-caution"
        ? `Your own cover is well-established practice, but availability and terms for parents at ${parentAge} vary sharply by insurer — treat that leg as subject to underwriting.`
        : "City, family-size and medical-inflation baselines are well established; final terms are subject to insurer underwriting.",
      alternative: useTopUp
        ? `A flat ${fmt(healthTotal)} policy remains preferable if you expect frequent claims *below* ${fmt(healthBase)} (single-claim simplicity), or if your employer already provides a matching top-up.`
        : `${fmt(healthBase)} base + top-up becomes worthwhile once your target crosses ~${fmt(healthBase + 10 * L)} — revisit after the next income jump.`,
      risks: (useTopUp ? "The top-up deductible must exactly match the base sum insured, and both policies must be claimed in sequence — keep them at the same insurer where possible. " : "")
        + (canPort ? "Apply to port at least 45 days before renewal (IRDAI portability) to carry served waiting periods; a fresh policy restarts them. " : "") /* [FIX F1] */
        + ((isYes(p.diabetes) || isYes(p.bp)) ? "Declared diabetes/hypertension usually attracts premium loading or condition exclusions and can mean decline — disclose fully; non-disclosure voids claims. " : "") /* [FIX F9] */
        + (parentsMode === "senior-caution" ? `At ${parentAge}, fresh cover typically carries 10–30% (sometimes higher) co-pay, loadings and up to 3-yr PED waiting — an insurer may decline; the ${fmt(parentsCorpus)} corpus is the reliable layer.` : "Subject to insurer underwriting and medical disclosures."), /* [FIX F1] PED capped at 36 months under current IRDAI norms */
      assumptions: "Employer cover valued at 50% (ends on exit); medical inflation 12–15%/yr; base layer sized to one typical hospitalisation in your city.", /* [§2] */
      changesWhen: "Marriage or a child (floater + larger total), a city move, an income-band change, a parent crossing 55 or 70, or any new diagnosis.", /* [§9] */
    },
  };

  /* ----- TERM LIFE — [P4] Human Life Value, not just income × multiplier ----- */
  const termNeeded = hasDependents || loans > 0;
  const termIssuable = age < 60; /* [FIX F2] new term entry age is typically 60–65; never sell what can't be bought */
  const loansOnly = termNeeded && !hasDependents; /* [FIX F3] borrower with no dependents ≠ income replacement */
  const workingSpouse = married && p.spouseDep === "earning";
  const mult = age < 30 ? 20 : age < 35 ? 18 : age < 40 ? 15 : age < 45 ? 13 : age < 50 ? 11 : 8;
  /* Working spouse sustains part of household expenses → income-replacement need drops ~20%. */
  const effMult = workingSpouse ? Math.round(mult * 0.8) : mult;
  /* [FIX F4] Education corpus scales with income: clamp(₹10L, 2.5× income, ₹50L) per child. */
  const eduPerChild = Math.min(50 * L, Math.max(10 * L, round5L(income * 2.5)));
  const eduFund = kids * eduPerChild;
  /* Existing investments do part of the job — 50% haircut for market risk + illiquidity. */
  const liquidOffset = Math.round(savings * 0.5);
  const hlvGross = loansOnly
    ? loans * 1.1 + income * 2 /* [FIX F3] loan protection + 2-yr transition buffer, not 20× income */
    : income * effMult + loans + eduFund;
  const hlvNet = Math.max(0, hlvGross - liquidOffset);
  /* [P4] Underwriting reality: insurers rarely issue beyond these income multiples. */
  const uwCapMult = age < 35 ? 25 : age < 45 ? 20 : age < 55 ? 15 : 10;
  const uwCap = income * uwCapMult;
  const termNow = num(p.covTermL) * L;
  const termCover = !termIssuable
    ? termNow /* [FIX F2] existing cover is the plan; new issue not realistic */
    : termNeeded
      ? Math.max(loansOnly ? 25 * L : 50 * L, Math.min(loansOnly ? round25L(hlvNet) : roundUp25L(hlvNet), roundUp25L(uwCap)))
      : round25L(income * 10);
  const termCapped = termIssuable && termNeeded && hlvNet > uwCap;
  const termGap = Math.max(0, (termIssuable && termNeeded ? termCover : 0) - termNow);
  /* ----- [P6] Homemaker spouse: replacement value, not income ----- */
  /* Childcare + household management + coordination ≈ max(₹2.4L/yr, 25% of household income),
     capitalised over ~12 years of dependency. Never hardcoded; clamped to a sane band. */
  const spouseCover = married && p.spouseDep === "homemaker"
    ? Math.min(100 * L, Math.max(25 * L, round25L(Math.max(2.4 * L, income * 0.25) * 12)))
    : 0;
  const term = {
    cover: termCover, needed: termNeeded, issuable: termIssuable, loansOnly, now: termNow, gap: termGap,
    spouseCover, capped: termCapped, priority: !termIssuable ? "Low" : termNeeded ? (loansOnly ? "Medium" : "High") : "Low",
    parts: { effMult, incomeReplace: loansOnly ? 0 : income * effMult, loans, eduFund, eduPerChild, liquidOffset, uwCap },
    meta: {
      formula: !termIssuable
        ? `At ${age}, new term policies are typically past entry age (usually 60–65). ${termNow > 0 ? `Your existing ${fmt(termNow)} continues per its own terms — do not let it lapse if dependents remain.` : "The realistic strategy is corpus-first: assets and health cover do the protecting from here."}` /* [FIX F2] */
        : loansOnly
          ? `Loan protection = 110% of ${fmt(loans)} outstanding + 2× income transition buffer (${fmt(income * 2)}) − 50% of investments (${fmt(liquidOffset)}) → ${fmt(termCover)}. No dependents, so income replacement isn't the goal — keeping the debt off your estate is.` /* [FIX F3] */
          : `HLV = ${effMult}× income (${fmt(income * effMult)})${workingSpouse ? " [20% lower — earning spouse]" : ""} + loans ${fmt(loans)}${eduFund ? ` + education corpus ${fmt(eduFund)} (${kids} × ${fmt(eduPerChild)})` : ""} − 50% of investments (${fmt(liquidOffset)}) = ${fmt(hlvNet)}${termCapped ? `, capped at the ~${uwCapMult}× income insurers will actually issue (${fmt(uwCap)})` : ""} → ${fmt(termCover)}`,
      confidence: !termIssuable ? "High" : termNeeded && income > 0 ? "High" : "Medium",
      confWhy: !termIssuable
        ? "Entry-age limits are consistent across the market; this is a structural fact, not a judgement call."
        : termNeeded
          ? `Income-replacement HLV with liability and asset adjustments is standard broker practice; issuance beyond ~${uwCapMult}× income is routinely declined, so the cap keeps this realistic.`
          : "Need depends on future dependents — revisit at the next life event.",
      alternative: !termIssuable
        ? "A health top-up plus a dedicated liquid corpus does the protective work new term no longer can."
        : spouseCover
          ? `Add ${fmt(spouseCover)} on your homemaker spouse — replacement value of childcare and household management, not income. Most families discover this gap only after a tragedy.`
          : workingSpouse
            ? `Around ${fmt(Math.max(50 * L, roundUp25L(hlvNet * 0.75)))} if your spouse's income can sustain household expenses long-term.`
            : loansOnly
              ? `A decreasing-cover loan-protection plan tracks the outstanding balance and costs less — but plain level term stays valid after prepayment.`
              : `Ladder it: ${fmt(Math.round(termCover * 0.6 / (25 * L)) * 25 * L)} till 60 + the balance till loan closure — trims premium ~15%.`,
      risks: !termIssuable
        ? "Some insurers write to entry age 65 with strict medicals and high rates — possible, rarely economical. Subject to insurer underwriting."
        : `Likely suitable subject to insurer underwriting and full medical/lifestyle disclosure — non-disclosure (especially tobacco) is the top reason death claims are contested.${isUnknown(p.smoker) ? " Tobacco status is unanswered — premiums shown assume non-tobacco; the quote changes if that answer changes." : ""}${termCapped ? " Your computed need exceeds typical issuance limits; close the balance via employer group cover or as income grows." : ""}${spouseCover ? " Homemaker cover is underwritten against the earning spouse's income — insurers commonly allow up to ~50% of the earner's own cover." : ""}`,
      assumptions: "Income replacement to ~age 60; investments offset at 50%; education corpus per child scales with income; new-issue entry age below 60.", /* [§2] */
      changesWhen: "A new loan, marriage, each child, a 20%+ salary change, spouse starting or stopping work, or crossing an age band (30/35/40/45/50).", /* [§9] */
    },
  };

  /* ----- PERSONAL ACCIDENT ----- */
  const paCover = Math.min(200 * L, round25L(income * 10)); /* [FIX F5] insurers cap PA around ₹1–2 Cr */
  const paNow = num(p.covPAL) * L;
  const paGap = Math.max(0, paCover - paNow);
  const accident = {
    cover: paCover, now: paNow, gap: paGap, priority: selfEmployed || paNow === 0 ? "High" : "Medium",
    meta: {
      formula: `10× annual income (${fmt(income)}) → ${fmt(paCover)}, covering accidental death + permanent & partial disability.`,
      confidence: "High",
      confWhy: "10× income is the standard PA convention; based on your profile it protects earning ability, which term cover doesn't.",
      alternative: "PA rider on your term plan — cheaper, but usually skips partial-disability and weekly income benefits. Standalone is likely more suitable.",
      risks: "Occupation class matters — desk roles get standard rates, field/hazardous work is loaded or excluded; declare it accurately." + (age >= 60 ? " Past ~60, new PA issuance narrows and benefits taper — buy earlier, renew rather than repurchase." : "") + " Subject to insurer underwriting." /* [P11][FIX F8] */,
      assumptions: "Desk-class occupation rates; 10× income convention; standalone policy benefits (not a rider).", /* [§2] */
      changesWhen: "An occupation change toward field or hazardous work, an income change, or turning 60.", /* [§9] */
    },
  };

  /* ----- CRITICAL ILLNESS ----- */
  const ciCover = Math.min(100 * L, Math.max(10 * L, round5L(income * 3))); /* [FIX F5] 10L floor — forcing ₹25L on a ₹2L income was tone-deaf */
  const ciNow = num(p.covCIL) * L;
  const ciGap = Math.max(0, ciCover - ciNow);
  const critical = {
    cover: ciCover, now: ciNow, gap: ciGap, priority: riskFactors > 0 || age >= 35 ? "High" : "Medium",
    meta: {
      formula: `3× annual income (${fmt(income)}) → ${fmt(ciCover)} lump sum on diagnosis — covers ~2–3 years of income while you recover.`,
      confidence: "Medium", /* CI sizing is always judgement; declared conditions add issuance uncertainty via confWhy/risks */
      confWhy: (isYes(p.diabetes) || isYes(p.bp))
        ? "3× income is the planning midpoint, but declared diabetes/hypertension makes CI issuance itself uncertain — loading, exclusion or decline are all common outcomes." /* [FIX F9] */
        : "Right-sizing CI depends on illness type and recovery time; 3× income is the accepted planning midpoint for your profile.",
      alternative: "CI rider on the term plan — 40–50% cheaper, but cover is capped and claim definitions are stricter than standalone policies.",
      risks: "CI policies pay only on listed conditions at defined severity, after a 90-day initial wait and typically a 30-day survival period — read definitions, not just the count of illnesses covered." + ((isYes(p.diabetes) || isYes(p.bp)) ? " With declared conditions, apply to multiple insurers through the broker; outcomes vary widely." : "") + (unknownFactors.length ? ` Unanswered: ${unknownFactors.join(", ")} — CI sizing and issuance both firm up once these are known.` : "") /* [§4] */ + (age >= 60 ? " New CI entry typically closes around 65 — the window is narrowing." : "") + " Subject to insurer underwriting." /* [P11][FIX F8][FIX F9] */,
      assumptions: "3× income planning midpoint; standalone claim definitions; standard 90-day initial wait and survival clause.", /* [§2] */
      changesWhen: "Any new diagnosis, an answered family-history question, crossing 35 or 40, or an income change.", /* [§9] */
    },
  };

  /* ----- MOTOR ----- */
  const hasVehicle = p.vehicle !== "none";
  const motorStatus = !hasVehicle ? "na" : p.vehicleIns === "comp" ? "covered" : p.vehicleIns === "tp" ? "upgrade" : "uninsured";
  const motor = {
    status: motorStatus, hasVehicle, zeroDep: num(p.vehicleAge, 0) <= 5,
    meta: {
      formula: hasVehicle ? "Comprehensive = mandatory third-party liability + own-damage cover" + (num(p.vehicleAge, 0) <= 5 ? " + zero-depreciation add-on (vehicle ≤ 5 yrs)." : ".") : "No vehicle owned.",
      confidence: "High",
      confWhy: "Third-party cover is a legal requirement under the Motor Vehicles Act.",
      alternative: motorStatus === "upgrade" ? "Standalone own-damage policy stacked on your existing third-party policy." : "—",
      risks: hasVehicle ? "A claim resets your no-claim bonus — for small dents, paying out of pocket often wins. Zero-dep usually caps claims per year." : "—" /* [P11] */,
      assumptions: "Zero-dep worthwhile while the vehicle is ≤5 years old; premium bands reflect the segment, not your exact IDV.", /* [§2] */
      changesWhen: "A vehicle purchase or sale, the vehicle turning 5, or a claim that resets the no-claim bonus.", /* [§9] */
    },
  };

  /* ----- EMERGENCY FUND ----- */
  const efMonths = age >= 55 ? 12 : selfEmployed ? 9 : 6; /* [FIX F6] flat 6 months ignored irregular income and pre-retirement reality */
  const efTarget = monthlyExp * efMonths;
  const efGap = Math.max(0, efTarget - savings);
  const emergency = {
    target: efTarget, months: efMonths, now: savings, gap: efGap,
    meta: {
      formula: `${efMonths} × monthly expenses (₹${monthlyExp.toLocaleString("en-IN")}) → ${fmt(efTarget)} in a liquid/sweep-FD fund${efMonths > 6 ? ` — ${age >= 55 ? "12 months near retirement" : "9 months for irregular income"}` : ""}.`, /* [FIX F6] */
      confidence: "High",
      confWhy: "6-month liquidity is the standard buffer before any investment-linked product.",
      alternative: efMonths >= 12 ? "Hold part in a sweep-FD ladder so it earns while staying liquid." : selfEmployed ? "Stretch toward 12 months if revenue is seasonal." : "3 months is the bare minimum if job security is very high.",
      assumptions: "Months scale with income stability: 6 salaried, 9 self-employed, 12 near retirement; the fund stays liquid, not invested.", /* [§2] */
      changesWhen: "A job change, income turning irregular, expense jumps, or crossing 55.", /* [§9] */
    },
  };

  /* ----- SCORES (×5) — [P7] indicative, weighted indicators; weights displayed in UI ----- */
  /* Health counts the base layer at full weight and the top-up layer at half —
     the base is the must-have, the top-up the strong recommendation. */
  const healthDenom = healthBase + 0.5 * healthTopUp;
  let protection = 0;
  protection += Math.min(1, healthDenom ? effHealthNow / healthDenom : 1) * 30;
  protection += !termIssuable
    ? (termNow > 0 ? 30 : 18) /* [FIX F19] past entry age: existing cover scores full; none scores neutral, not negligent */
    : termNeeded ? Math.min(1, termCover ? termNow / termCover : 0) * 30 : 24;
  protection += Math.min(1, ciNow / ciCover) * 14;
  protection += Math.min(1, paNow / paCover) * 10;
  protection += !hasVehicle ? 6 : motorStatus === "covered" ? 6 : motorStatus === "upgrade" ? 3 : 0;
  protection += efTarget > 0 ? Math.min(1, savings / efTarget) * 10 : 8;
  protection -= riskFactors * (ciGap > 0 ? 2 : 0.5);
  protection = Math.max(0, Math.min(100, Math.round(protection)));
  /* [P7] Weights reflect severity × frequency of financial ruin: death of an earner and a
     major medical event dominate; shown to the user, never claimed as actuarially precise. */
  const scoreWeights = [
    ["Health (base full + top-up ½)", 30], ["Term life", 30], ["Critical illness", 14],
    ["Personal accident", 10], ["Emergency fund", 10], ["Motor", 6],
  ];
  const scoreConfidence = completeness.pct >= 85 && unknownFactors.length === 0 ? "High"
    : completeness.pct >= 60 && unknownFactors.length <= 2 ? "Medium" : "Low"; /* [§3] information completeness, never a fake % */

  let healthRisk = Math.max(0, (age - 25) * 0.8);
  if (isYes(p.smoker)) healthRisk += 18;
  if (isYes(p.diabetes)) healthRisk += 14;
  if (isYes(p.bp)) healthRisk += 12;
  if (isYes(p.famHistory)) healthRisk += 10; /* [§4] unknowns don't inflate risk — they lower confidence */
  healthRisk = Math.max(0, Math.min(100, Math.round(healthRisk)));

  let finStability = 0;
  finStability += efTarget > 0 ? Math.min(1, savings / efTarget) * 30 : 24;
  const dti = income > 0 ? loans / income : 5;
  finStability += Math.max(0, 1 - dti / 5) * 30;
  finStability += income >= 25 * L ? 20 : income >= 12 * L ? 15 : income >= 6 * L ? 10 : 6;
  finStability += (protection / 100) * 20;
  finStability = Math.max(0, Math.min(100, Math.round(finStability)));

  const emergencyReady = efTarget > 0 ? Math.min(100, Math.round((savings / efTarget) * 100)) : 80;

  /* [P9] Claim readiness — expanded checklist; every missing item is surfaced to the user. */
  let claimReady = 0;
  const claimGaps = [];
  const crCheck = (ok, pts, label) => { if (ok) claimReady += pts; else claimGaps.push(label); };
  crCheck(p.nominee, married ? 15 : 30, "Nominee registered on every policy"); /* [§8] rebalanced — both states sum to 100 */
  if (married) crCheck(p.nomineeUpdated, 15, "Nominee updated after marriage"); /* claims paid to an ex-nominee parent are a real, recurring tragedy */
  crCheck(p.kyc, married ? 15 : 15, "KYC complete across insurers");
  crCheck(p.docsOk, 10, "Policy documents accessible to family");
  crCheck(p.renewalReminder, 10, "Renewal reminders set");
  crCheck(p.emgContact, 10, "Family knows whom to call at the insurer/broker");
  crCheck(p.claimFile, married ? 10 : 10, "Claim file ready — policy list, ID copies and contacts in one folder"); /* [§8] */
  crCheck(termNow > 0 || num(p.covHealthL) > 0, 10, "At least one personal policy active");
  crCheck((p.email || "").includes("@") && (p.phone || "").length >= 10, 5, "Contact details on record");
  claimReady = Math.min(100, claimReady);

  const band = protection >= 75 ? "Well protected" : protection >= 45 ? "Building cover" : "At risk";

  /* biggest gap label (for admin analytics) */
  const gapPairs = [["Term life", termNeeded ? termGap : 0], ["Health", healthGap], ["Personal accident", paGap], ["Critical illness", ciGap], ["Emergency fund", efGap]];
  gapPairs.sort((a, b) => b[1] - a[1]);
  const topGap = gapPairs[0][1] > 0 ? gapPairs[0][0] : "None";

  const c = {
    income, loans, savings, age, married, metro, selfEmployed, hasDependents,
    riskFactors, kids, parentAge, health, term, accident, critical, motor, emergency,
    score: protection, band, topGap,
    scores: { protection, healthRisk, finStability, emergencyReady, claimReady },
    scoreWeights, scoreConfidence, claimGaps, completeness, unknownFactors, /* [P7][P9][§3][§4] */
  };
  c.afford = affordability(p, c); /* [P5] steady-state premium load vs income */
  return c;
}

/** Indicative annual premium ranges (₹). Heuristic bands, never insurer pricing. */
function premiumRange(kind, cover, p, c) {
  const age = c.age;
  if (kind === "term") {
    const per = age < 30 ? [9, 13] : age < 35 ? [11, 16] : age < 40 ? [14, 20] : age < 45 ? [19, 28] : age < 50 ? [26, 38] : age < 55 ? [36, 55] : [55, 85]; // ₹k per ₹1 Cr [FIX F7]
    const x = (isYes(p.smoker) ? 1.6 : 1) * cover / 10000000; /* [§4] unknown priced as non-tobacco; risks note flags it */
    return [Math.round(per[0] * 1000 * x), Math.round(per[1] * 1000 * x)];
  }
  if (kind === "health") {
    const per = age < 35 ? [700, 1000] : age < 45 ? [900, 1400] : age < 55 ? [1400, 2100] : age < 65 ? [2100, 3200] : [3200, 4800]; /* [FIX F7] */
    return per.map((r) => Math.round(r * cover / L));
  }
  if (kind === "topup") { /* [P1] super top-up: claims only above the deductible → ~25–30% of base per-₹L rates */
    const per = age < 35 ? [180, 300] : age < 45 ? [250, 420] : age < 55 ? [400, 650] : age < 65 ? [650, 1000] : [1000, 1500]; /* [FIX F7] */
    return per.map((r) => Math.round(r * cover / L));
  }
  if (kind === "parents") {
    const per = c.parentAge >= 70 ? [3200, 4500] : [2200, 3200];
    return per.map((r) => Math.round(r * cover / L));
  }
  if (kind === "ci") {
    const per = age < 35 ? [250, 400] : age < 45 ? [400, 650] : age < 55 ? [700, 1100] : [1100, 1700]; /* [FIX F7] */
    return per.map((r) => Math.round(r * (isYes(p.smoker) ? 1.5 : 1) * cover / L));
  }
  if (kind === "pa") return [60, 100].map((r) => Math.round(r * cover / L));
  if (kind === "motor") {
    const car = p.vehicle === "car" || p.vehicle === "both";
    let base = p.vehicle === "both" ? [9500, 21000] : car ? [8000, 18000] : [1500, 3000];
    const zd = c.motor.zeroDep ? 1.25 : 1;
    return base.map((r) => Math.round(r * zd));
  }
  return [0, 0];
}

/* [P5] Protection affordability — the steady-state annual premium if the client follows
   the full plan, held against the broker norm of ~5–6% of income for pure protection. */
function affordability(p, c) {
  let lo = 0, hi = 0;
  const add = (kind, cover, f = 1) => {
    if (cover > 0) { const [a, b] = premiumRange(kind, cover, p, c); lo += a * f; hi += b * f; }
  };
  if (c.health.structure === "topup") { add("health", c.health.base); add("topup", c.health.topUp); }
  else add("health", c.health.cover);
  if (c.health.parentsPlan) add("parents", c.health.parentsPlan, c.health.parentsMode === "senior-caution" ? 1.15 : 1); // likely loadings at 70+
  if (c.term.needed && c.term.issuable) add("term", c.term.cover); /* [FIX F20] */
  if (c.term.issuable && c.term.spouseCover) add("term", c.term.spouseCover, 0.8); // homemaker spouse, indicative — gated on entry age
  add("pa", c.accident.cover);
  add("ci", c.critical.cover);
  if (c.motor.hasVehicle) {
    const [a, b] = premiumRange("motor", 0, p, c);
    const f = c.motor.status === "upgrade" ? 0.35 : 1;
    lo += a * f; hi += b * f;
  }
  lo = Math.round(lo); hi = Math.round(hi);
  const mid = Math.round((lo + hi) / 2);
  const ratio = c.income > 0 ? mid / c.income : 0;
  const status = ratio <= 0.06 ? "green" : ratio <= 0.09 ? "yellow" : "red";
  return {
    lo, hi, mid, ratio, pct: Math.round(ratio * 1000) / 10, status,
    budgetSuggest: Math.max(5000, Math.round((c.income * 0.06) / 1000) * 1000),
  };
}

/** Gap table rows with financial exposure + cost-to-close. */
function gapRows(p, c) {
  const rows = [];
  const add = (name, now, rec, gap, priority, kind, cover) => {
    const [lo, hi] = gap > 0 ? premiumRange(kind, gap, p, c) : [0, 0];
    rows.push({ name, now, rec, gap, priority, exposure: gap, costLo: lo, costHi: hi, cover });
  };
  add("Health (self" + (c.health.floater ? "/family" : "") + (c.health.structure === "topup" ? ", base + top-up" : "") + ")", c.health.now, c.health.cover, c.health.gap, "High", "health");
  if (c.health.parentsPlan) add(c.health.parentsMode === "senior-caution" ? "Parents' health (subject to underwriting at " + c.parentAge + ")" : "Parents' health plan", 0, c.health.parentsPlan, c.health.parentsPlan, c.health.parentsMode === "senior-caution" ? "Medium" : "High", "parents"); /* [P2] */
  add(c.term.issuable ? "Term life" : "Term life (past typical entry age)", c.term.now, c.term.issuable && c.term.needed ? c.term.cover : c.term.now, c.term.issuable && c.term.needed ? c.term.gap : 0, c.term.priority, "term"); /* [FIX F20] */
  if (c.term.issuable && c.term.spouseCover) add("Term — homemaker spouse (replacement value)", 0, c.term.spouseCover, c.term.spouseCover, "Medium", "term"); /* [P6] */
  add("Personal accident", c.accident.now, c.accident.cover, c.accident.gap, c.accident.priority, "pa");
  add("Critical illness", c.critical.now, c.critical.cover, c.critical.gap, c.critical.priority, "ci");
  if (c.motor.hasVehicle && c.motor.status !== "covered") {
    const [lo, hi] = premiumRange("motor", 0, p, c);
    rows.push({ name: "Motor (comprehensive)", now: 0, rec: 0, gap: 0, priority: "High", exposure: c.motor.status === "uninsured" ? "Legal + full vehicle risk" : "Own-damage uncovered", costLo: c.motor.status === "upgrade" ? Math.round(lo * 0.35) : lo, costHi: c.motor.status === "upgrade" ? Math.round(hi * 0.35) : hi, motor: true });
  }
  rows.push({ name: "Emergency fund", now: c.emergency.now, rec: c.emergency.target, gap: c.emergency.gap, priority: c.emergency.gap > 0 ? "High" : "Low", exposure: c.emergency.gap, costLo: 0, costHi: 0, fund: true });
  return rows;
}

/** Budget optimizer — priority-ordered greedy allocation using midpoint premiums. */
function optimizeBudget(p, c, budget) {
  const items = [];
  if (c.motor.hasVehicle && c.motor.status === "uninsured") {
    const [lo, hi] = premiumRange("motor", 0, p, c);
    items.push({ name: "Motor — comprehensive (legal must)", fixed: Math.round((lo + hi) / 2), rank: 0 });
  }
  const push = (name, gap, unit, kind, rank) => { if (gap > 0) items.push({ name, gap, unit, kind, rank }); };
  /* [§7] priority order per broker practice: health first (claims are frequent), then term (ruin is worst), then PA, then CI */
  push("Health (self" + (c.health.floater ? "/family" : "") + (c.health.structure === "topup" ? " · base+top-up" : "") + ")", c.health.gap, L, "health", 1);
  if (c.term.needed && c.term.issuable) push("Term life", c.term.gap, 25 * L, "term", 3); /* [FIX F20] */
  if (c.health.parentsPlan) push(c.health.parentsMode === "senior-caution" ? "Parents' health (if an insurer issues)" : "Parents' health", c.health.parentsPlan, L, "parents", 2); /* [P2] */
  if (c.term.issuable && c.term.spouseCover) push("Term — homemaker spouse", c.term.spouseCover, 25 * L, "term", 3.5); /* [P6] */
  push("Personal accident", c.accident.gap, 5 * L, "pa", 4);
  push("Critical illness", c.critical.gap, 5 * L, "ci", 5);
  if (c.motor.hasVehicle && c.motor.status === "upgrade") {
    const [lo, hi] = premiumRange("motor", 0, p, c);
    items.push({ name: "Motor — upgrade to comprehensive", fixed: Math.round((lo + hi) * 0.35), rank: 6 });
  }
  items.sort((a, b) => a.rank - b.rank);

  let rem = budget, needLo = 0, needHi = 0;
  const rows = [];
  for (const it of items) {
    if (it.fixed != null) {
      needLo += it.fixed; needHi += it.fixed;
      if (rem >= it.fixed) { rows.push({ name: it.name, alloc: it.fixed, bought: "Full policy", left: 0 }); rem -= it.fixed; }
      else rows.push({ name: it.name, alloc: 0, bought: "—", left: it.fixed, note: "Deferred — over budget" });
      continue;
    }
    const [lo, hi] = premiumRange(it.kind, it.gap, p, c);
    needLo += lo; needHi += hi;
    const rate = (lo + hi) / 2 / it.gap;
    const fullCost = Math.round(rate * it.gap);
    if (rem >= fullCost) { rows.push({ name: it.name, alloc: fullCost, bought: fmt(it.gap) + " cover", left: 0 }); rem -= fullCost; }
    else {
      const affordable = Math.floor(rem / (rate * it.unit)) * it.unit;
      if (affordable > 0) {
        const cost = Math.round(rate * affordable);
        rows.push({ name: it.name, alloc: cost, bought: `${fmt(affordable)} of ${fmt(it.gap)}`, left: it.gap - affordable, note: "Partial — top up next cycle" });
        rem -= cost;
      } else rows.push({ name: it.name, alloc: 0, bought: "—", left: it.gap, note: "Deferred" });
    }
  }
  return { rows, leftover: Math.max(0, Math.round(rem)), needLo, needHi };
}

/** Life events — pure profile transforms so the simulator is instant. */
const LIFE_EVENTS = [
  { k: "marriage", label: "Marriage", icon: Heart, note: "Health moves to a family floater; homemaker spouse gets replacement-value cover; nominee update becomes a pending task.", next: "Next: convert the floater within 60 days, update every nominee, and re-run this plan.", apply: (p) => ({ ...p, marital: "married", spouseDep: "homemaker", nomineeUpdated: false }) }, /* [P6][P9] */
  { k: "child", label: "Child birth", icon: Baby, note: "Term +₹50 L for education corpus; add child to floater after day-90 window.", next: "Next: add the child to the floater after day 90 and raise term at the same renewal.", apply: (p) => ({ ...p, kids: String(Math.min(3, num(p.kids) + 1)) }) },
  { k: "house", label: "New house", icon: Home, note: "Add home structure + contents cover (~₹1.5–3k/yr) — cheap and skipped by most.", next: "Next: buy structure + contents cover with the registration paperwork — it is a 10-minute policy.", apply: (p) => ({ ...p, ownsHouse: true }) },
  { k: "loan", label: "Home loan +₹30 L", icon: Banknote, note: "Term cover must absorb the new liability so the family never inherits the EMI.", next: "Next: raise term by the new loan amount before the first EMI, not after.", apply: (p) => ({ ...p, loansL: String(num(p.loansL) + 30), ownsHouse: true }) },
  { k: "job", label: "Job change", icon: Briefcase, note: "Employer health vanishes during notice + waiting period — personal cover is the only net.", next: "Next: confirm your personal health policy is active before the last working day.", apply: (p) => ({ ...p, covEmpHealthL: "0" }) },
  { k: "salary", label: "Salary +20%", icon: TrendingUp, note: "Covers should track lifestyle inflation, not your joining-day salary.", next: "Next: raise covers at the next renewal so protection tracks the new lifestyle.", apply: (p) => ({ ...p, incomeL: String(Math.round(num(p.incomeL) * 1.2)) }) },
  { k: "retire", label: "Retirement", icon: Sunset, note: "Term can lapse if the corpus is built; health becomes the critical cover for life.", next: "Next: shift focus to health + corpus; stop premiums on cover the corpus now replaces.", apply: (p) => ({ ...p, age: "60", incomeL: String(Math.max(1, Math.round(num(p.incomeL) * 0.3))) }) },
  { k: "parents", label: "Parents retire", icon: Users, note: "Their employer cover ends — a separate senior-citizen plan becomes urgent.", next: "Next: apply for their senior plan before the next birthday; start the medical corpus either way.", apply: (p) => ({ ...p, parentsDep: true, parentAge: String(Math.max(60, num(p.parentAge) || 60)) }) },
];

/** [P10] Insurance strategy — action-first milestones, not just policy names. */
function buildRoadmap(p, c) {
  const ms = [];
  /* Today: concrete buy/port actions on the biggest exposures. */
  const today = [];
  if (c.motor.hasVehicle && c.motor.status === "uninsured") today.push("Buy comprehensive motor cover — driving uninsured is illegal before it is risky.");
  if (c.health.gap > 0) today.push(
    (c.health.canPort ? `Port your existing ${fmt(num(p.covHealthL) * L)} policy at renewal and enhance to ` : "Buy ")
    + (c.health.structure === "topup" ? `${fmt(c.health.base)} base + ${fmt(c.health.topUp)} super top-up (deductible ${fmt(c.health.deductible)})` : `a ${fmt(c.health.cover)} policy`)
    + (c.health.canPort ? " — porting preserves your served waiting periods." : " — every year you wait restarts the waiting-period clock older."));
  if (c.term.needed && c.term.gap > 0) today.push(`Buy ${fmt(c.term.gap)} term cover (target ${fmt(c.term.cover)}) — at ${c.age}, each birthday adds roughly 4–8% to the premium for life.`);
  ms.push({ when: "Today", title: "Buy / port the foundations", points: today.length ? today : ["No urgent purchase — maintain covers and review annually."] });
  /* Next 6 months: readiness + parents. */
  const six = [];
  if (c.emergency.gap > 0) six.push(`Grow the emergency fund to ${fmt(c.emergency.target)} — you're ${fmt(c.emergency.gap)} short; automate a monthly sweep.`);
  if (c.health.parentsMode === "senior-plan") six.push(`Move parents to a dedicated ${fmt(c.health.parentsPlan)} senior plan before the next birthday raises premiums and tightens underwriting.`);
  if (c.health.parentsMode === "senior-caution") six.push(`Attempt ${fmt(c.health.parentsPlan)} senior cover for parents (expect co-pay/loading, possibly decline) and start a ${fmt(c.health.parentsCorpus)} medical corpus in parallel — the corpus is the layer no underwriter can refuse.`);
  c.claimGaps.slice(0, 3).forEach((g) => six.push(`Fix claim readiness: ${g.toLowerCase()}.`));
  ms.push({ when: "Next 6 months", title: "Readiness & parents", points: six.length ? six : ["Automate premium payments and set renewal reminders."] });
  /* Next year: keep covers tracking life. */
  ms.push({ when: "Next 12 months", title: "Keep cover tracking income", points: [
    "Review at appraisal — raise covers with income so protection tracks lifestyle, not joining-day salary.",
    c.critical.gap > 0 ? `Close the remaining ${fmt(c.critical.gap)} critical-illness gap once health + term are in force.` : "Re-confirm critical illness stays at ~3× income.",
    "Re-shop motor at renewal; never let the no-claim bonus lapse.",
  ] });
  if (!c.married) ms.push({ when: "After marriage", title: "Two lives, one plan", points: [
    `Convert health to a family floater and re-run the structure (target moves toward ${fmt(c.metro ? 50 * L : 30 * L)} total).`,
    "Update the nominee on every policy within the month — claims paid to an outdated nominee are a recurring tragedy.",
    "If your spouse is a homemaker, add replacement-value term cover on them (childcare + household management, typically ₹25 L–1 Cr).",
  ] });
  if (c.kids === 0) ms.push({ when: "After first child", title: "Education-proofing", points: [
    "Raise term by ~₹25 L per child for the education corpus (the engine adds this automatically).",
    "Add the child to the floater after the day-90 window.",
    "Start a separate education investment — insurance is protection, not the investment vehicle.",
  ] });
  if (c.age < 40) ms.push({ when: "Age 40", title: "Mid-career review", points: [
    "Raise critical illness toward 4–5× income — incidence climbs sharply post-40.",
    `Widen the super top-up layer (health inflation compounds at 12–15%).`,
    "Re-check term against new loans and lifestyle.",
  ] });
  if (c.age < 50) ms.push({ when: "Age 50", title: "Pre-retirement posture", points: [
    "Step term cover down as the corpus steps up — protection can taper when assets can do the job.",
    "Confirm health policies have lifelong renewability with no fresh waiting periods.",
    "Complete senior-citizen health planning for self/spouse before 55 — underwriting tightens fast after that.",
  ] });
  ms.push({ when: "Retirement", title: "Protection flips to health-first", points: [
    "Let term lapse once the corpus can replace it — paying for cover you no longer need is a leak.",
    `Health with restoration benefit becomes the core policy; keep the total near ${fmt(Math.max(25 * L, c.health.cover))}.`,
    "Hold the emergency fund at 12 months of expenses and keep claim documents where family can find them.",
  ] });
  return ms;
}

/** Deterministic reasoning used instantly and whenever the AI is unreachable. */
function fallbackReasons(p, c) {
  const inc = fmt(c.income);
  return {
    health: (c.health.structure === "topup"
      ? `Based on your profile, ${fmt(c.health.cover)} total protection structured as ${fmt(c.health.base)} base + ${fmt(c.health.topUp)} super top-up (deductible ${fmt(c.health.deductible)}) is likely suitable — the top-up layer prices at roughly a quarter of base rates, saving ≈ ${fmt(c.health.save)}/yr versus one flat ${fmt(c.health.cover)} policy while covering the same big event. `
      : `Based on your profile, a single ${fmt(c.health.cover)} policy is the cleaner choice — at this size a top-up layer adds paperwork without meaningful savings. `)
      + (c.health.canPort ? `You already hold ${fmt(num(p.covHealthL) * L)} — port and enhance it at renewal rather than buying fresh, so your served waiting periods carry over (IRDAI portability). ` : `Buying young matters mainly for waiting periods: the pre-existing-disease clock (capped at 3 years) only runs while you hold a policy. `)
      + `Employer cover is weighted at half because it ends the day you change jobs.`
      + (c.health.parentsMode === "senior-plan" ? ` Keep parents (${c.parentAge}) on a separate ${fmt(c.health.parentsPlan)} senior plan — adding them to your floater inflates everyone's premium.` : "")
      + (c.health.parentsYoung ? ` Your parents are under 55 — a standard separate policy for them is inexpensive now and starts their waiting-period clock before age makes cover costly.` : "")
      + (c.health.parentsMode === "senior-caution" ? ` At ${c.parentAge}, fresh cover for parents is genuinely hard — expect co-pay, loadings, waiting periods, possibly a decline. Attempt ${fmt(c.health.parentsPlan)} of cover, but build a ${fmt(c.health.parentsCorpus)} medical corpus and align family support in parallel; that combination is the realistic plan, subject to insurer underwriting.` : ""),
    term: !c.term.issuable /* [FIX F2] */
      ? `${c.term.now > 0 ? `Your existing ${fmt(c.term.now)} term policy is the asset here — keep it in force while dependents remain. ` : ""}At ${c.age}, new term is past typical entry age (60–65), so based on your profile the protective work shifts to health cover and a liquid corpus rather than a policy no insurer will realistically write.`
      : c.term.loansOnly /* [FIX F3] */
        ? `With ${fmt(c.loans)} outstanding and no financial dependents, the goal is keeping debt off your estate — not income replacement. ${fmt(c.term.cover)} (110% of the loan plus a two-year buffer) does that at minimal premium, subject to insurer underwriting; revisit sizing the day someone depends on your income.`
        : c.term.needed
          ? `Considering your ${inc}/yr income${c.term.parts.eduFund ? `, ${c.kids} child${c.kids > 1 ? "ren" : ""}'s education` : ""} and ${fmt(c.loans)} in loans — less half your investments already doing this job — ${fmt(c.term.cover)} is the indicated cover${c.term.capped ? " (capped at what insurers will realistically issue for your income)" : ""}. At ${c.age} the premium is near its lifetime floor; it's subject to underwriting and full disclosure.`
            + (c.term.spouseCover ? ` Separately, ${fmt(c.term.spouseCover)} on your homemaker spouse reflects the replacement cost of childcare and household management — a gap most families never price.` : "")
          : `With no dependents or loans on your profile, term isn't urgent today. Buying ~${fmt(c.term.cover)} early still locks a low lifetime premium — revisit at marriage or your first big loan.`,
    accident: `${fmt(c.accident.cover)} (≈10× income) protects what your finances actually run on — your ability to work. Term pays only on death; this covers disability, which is statistically more common${c.selfEmployed ? ", and you have no employer safety net" : ""}. Suitable for most earning profiles, subject to occupation-class underwriting.`,
    critical: `${fmt(c.critical.cover)} pays a lump sum on diagnosis of listed major illnesses.${isYes(p.famHistory) ? " Given the heart/cancer family history on your profile, this deserves top priority." : isUnknown(p.famHistory) ? " Family history is unanswered — if heart/cancer runs in the family, this moves to top priority; answering firms up the plan." : ""}${isYes(p.smoker) ? " Tobacco use raises both risk and future premiums — buying before insurers reprice you is likely the better sequence." : ""} Health insurance pays hospitals; this replaces income while you recover.`,
    motor: !c.motor.hasVehicle ? "You don't own a vehicle — nothing needed here."
      : c.motor.status === "uninsured" ? "Driving without third-party cover is illegal in India. Go straight to comprehensive — it also covers your own vehicle's damage and theft."
      : c.motor.status === "upgrade" ? `Third-party only protects others. Upgrade to comprehensive${c.motor.zeroDep ? " with zero-depreciation (vehicle under 5 years)" : ""} so your own repair bills are covered.`
      : "Comprehensive cover in place — protect the no-claim bonus and renew on time.",
    emergency: c.emergency.gap > 0
      ? `Build ${fmt(c.emergency.target)} (${c.emergency.months} months of expenses) in a liquid fund before any investment-linked policy. You're ${fmt(c.emergency.gap)} short — this is what stops a job loss becoming a debt spiral.`
      : `Your emergency fund covers ${c.emergency.months}+ months of expenses — the foundation is solid.`,
    overall: `At ${c.age}, protection is near its price floor and underwriting is easiest — each year of delay adds premium and exclusions. The full plan runs ≈ ${fmt(c.afford.lo)}–${fmt(c.afford.hi)}/yr (~${c.afford.pct}% of income${c.afford.status === "green" ? ", comfortably inside the 5–6% norm" : c.afford.status === "yellow" ? ", slightly above the 5–6% norm — sequence purchases by priority" : " — above the 5–6% norm, so use the budget optimizer to sequence by priority"}). Sequence health first (claims are frequent), then term (the worst ruin), then PA and CI — keep insurance and investment strictly separate, and revisit at every life event.`,
  };
}

/* ============================== §4 API LAYER ================================== */

/** Claude call with retry + timeout-ish behaviour. */
async function callClaude(messages, tries = 2) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1000, messages }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const txt = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (!txt) throw new Error("Empty response");
      return txt;
    } catch (e) { lastErr = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, 800)); }
  }
  throw lastErr;
}
const parseJson = (t) => JSON.parse(t.replace(/```json|```/g, "").trim());

/** Storage adapter — artifact persistent storage when available, memory otherwise.
 *  In a real deployment this file becomes src/api/storage.ts backed by your DB. */
const memStore = new Map();
const ws = () => (typeof window !== "undefined" && window.storage ? window.storage : null);
async function stSet(key, obj) {
  memStore.set(key, obj);
  const s = ws();
  if (s) { try { await s.set(key, JSON.stringify(obj)); } catch (e) { /* quota/key errors → memory only */ } }
}
async function stGet(key) {
  const s = ws();
  if (s) { try { const r = await s.get(key); if (r) { const v = JSON.parse(r.value); memStore.set(key, v); return v; } } catch (e) { /* missing key */ } }
  return memStore.get(key) ?? null;
}
async function stKeys(prefix) {
  const s = ws();
  if (s) { try { const r = await s.list(prefix); if (r?.keys) return r.keys; } catch (e) {} }
  return [...memStore.keys()].filter((k) => k.startsWith(prefix));
}
async function stDel(key) { /* [P8] */
  memStore.delete(key);
  const s = ws();
  if (s) { try { await s.delete(key); } catch (e) { /* already gone */ } }
}
/* [P8] DPDP right to erasure — removes every stored lead matching this email on this device/app.
   Rows already synced to the broker's Google Sheet must be deleted by the admin (noted in UI). */
async function deleteMyData(email) {
  if (!email) return 0;
  const keys = await stKeys("lead:");
  let n = 0;
  for (const k of keys) {
    const v = await stGet(k);
    if (v && (v.email || "").toLowerCase() === email.toLowerCase()) { await stDel(k); n++; }
  }
  return n;
}

/** Leads DB (feature 11) + optional Google Sheets sync. */
async function saveLead(lead) { await stSet("lead:" + lead.id, lead); }
async function listLeads() {
  const keys = await stKeys("lead:");
  const out = [];
  for (const k of keys) { const v = await stGet(k); if (v) out.push(v); }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}
/** POST with no custom headers → text/plain body → no CORS preflight (Apps Script friendly). */
async function syncToSheets(url, lead) {
  if (!url) return { ok: false, why: "No webhook configured" };
  try {
    const secret = (await stGet("settings:secret")) || ""; /* [§13] shared secret rejects webhook abuse server-side */
    const res = await fetch(url, { method: "POST", body: JSON.stringify({ ...lead, secret }) });
    return { ok: res.ok };
  } catch (e) {
    return { ok: false, why: "Blocked in Claude preview — works once deployed outside claude.ai" };
  }
}
async function fetchSheetLeads(url) {
  const res = await fetch(url + (url.includes("?") ? "&" : "?") + "action=leads");
  if (!res.ok) throw new Error("HTTP " + res.status);
  return await res.json();
}

const profileSummary = (p, c) => JSON.stringify({
  name: p.name, age: c.age, maritalStatus: p.marital, city: p.cityTier, occupation: p.occupation,
  annualIncome: fmt(c.income), monthlyExpenses: "₹" + num(p.monthlyExp).toLocaleString("en-IN"),
  loans: fmt(c.loans), savings: fmt(c.savings), childrenCount: c.kids,
  spouseStatus: p.marital === "married" ? p.spouseDep : "n/a",
  parentsDependent: p.parentsDep, parentAge: p.parentsDep ? c.parentAge : "n/a",
  ownsHouse: !!p.ownsHouse,
  healthFlags: { smoker: tri(p.smoker), diabetes: tri(p.diabetes), highBP: tri(p.bp), familyHistory: tri(p.famHistory) }, /* [§4] yes/no/unknown, never assumed */
  goals: p.goals, vehicle: p.vehicle, vehicleInsurance: p.vehicleIns,
  claimReadiness: { nomineeRegistered: !!p.nominee, nomineeUpdatedAfterMarriage: !!p.nomineeUpdated, kycComplete: !!p.kyc, documentsAccessible: !!p.docsOk, renewalReminders: !!p.renewalReminder, familyKnowsWhomToCall: !!p.emgContact, claimFileReady: !!p.claimFile },
  existingCover: { employerHealth: fmt(num(p.covEmpHealthL) * L), personalHealth: fmt(num(p.covHealthL) * L), termLife: fmt(num(p.covTermL) * L), criticalIllness: fmt(num(p.covCIL) * L), personalAccident: fmt(num(p.covPAL) * L) },
});
const planSummary = (c) => JSON.stringify({
  scores: c.scores, band: c.band, scoreConfidence: c.scoreConfidence, profileCompleteness: c.completeness.pct + "%", unanswered: c.unknownFactors, claimReadinessGaps: c.claimGaps,
  affordability: { annualPremiumRange: `${fmt(c.afford.lo)}–${fmt(c.afford.hi)}`, pctOfIncome: c.afford.pct + "%", status: c.afford.status, norm: "5–6% of income for pure protection" }, /* [P5] */
  health: { /* [P1][P2][P3] */
    totalRecommended: fmt(c.health.cover), structure: c.health.structure === "topup" ? `${fmt(c.health.base)} base + ${fmt(c.health.topUp)} super top-up, deductible ${fmt(c.health.deductible)}` : "single policy",
    estAnnualSavingVsFlat: c.health.save ? fmt(c.health.save) : "n/a", action: c.health.canPort ? "PORT existing policy + enhance (preserves waiting periods)" : "buy new",
    parents: c.health.parentsMode === "senior-caution" ? `age ${c.parentAge}: attempt ${fmt(c.health.parentsPlan)} (co-pay/loading/decline possible) + ${fmt(c.health.parentsCorpus)} medical corpus + family support; confidence Medium` : c.health.parentsPlan ? `separate senior plan ${fmt(c.health.parentsPlan)}` : c.health.parentsYoung ? "dependent parents under 55 — standard separate policy, inexpensive now" : "n/a",
    currentEffective: fmt(c.health.now), gap: fmt(c.health.gap),
  },
  termLife: { recommended: fmt(c.term.cover), needed: c.term.needed, cappedAtUnderwritingLimit: !!c.term.capped, homemakerSpouseCover: c.term.spouseCover ? fmt(c.term.spouseCover) + " (replacement value)" : "n/a", current: fmt(c.term.now), gap: fmt(c.term.gap) }, /* [P4][P6] */
  personalAccident: { recommended: fmt(c.accident.cover), gap: fmt(c.accident.gap) },
  criticalIllness: { recommended: fmt(c.critical.cover), gap: fmt(c.critical.gap) },
  motor: { status: c.motor.status }, emergencyFund: { target: fmt(c.emergency.target), gap: fmt(c.emergency.gap) },
});

/* ================================ §5 HOOKS ==================================== */
function useLeads(active) {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(false);
  const reload = async () => { setLoading(true); try { setLeads(await listLeads()); } finally { setLoading(false); } };
  useEffect(() => { if (active) reload(); }, [active]);
  return { leads, loading, reload };
}

/* ============================ §6 UI PRIMITIVES ================================ */
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  render() {
    if (this.state.err) return (
      <div className="max-w-md mx-auto mt-16 p-6 rounded-xl border text-center" style={{ background: "#fff", borderColor: "var(--line)" }}>
        <AlertTriangle className="mx-auto mb-2" style={{ color: "var(--red)" }} />
        <p className="font-semibold mb-1">Something broke in the interface.</p>
        <p className="text-sm mb-3" style={{ color: "var(--mute)" }}>{String(this.state.err?.message || this.state.err)}</p>
        <button onClick={() => this.setState({ err: null })} className="px-4 py-2 rounded-lg text-white text-sm" style={{ background: "var(--pine)" }}>Try again</button>
      </div>
    );
    return this.props.children;
  }
}

const Field = ({ label, hint, children }) => (
  <div className="mb-4">
    <label className="block text-sm font-medium mb-1" style={{ color: "var(--ink)" }}>
      {label} {hint && <span className="font-normal" style={{ color: "var(--mute)" }}>· {hint}</span>}
    </label>
    {children}
  </div>
);
const inputCls = "w-full rounded-lg px-3 py-2 text-sm bg-white outline-none input-brand";
const NumInput = ({ value, onChange, placeholder }) => (
  <input type="number" inputMode="decimal" className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
);
const TextInput = ({ value, onChange, placeholder, type = "text" }) => (
  <input type={type} className={inputCls} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
);
const SelectInput = ({ value, onChange, options }) => (
  <select className={inputCls} value={value} onChange={(e) => onChange(e.target.value)}>
    {options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
  </select>
);
/* [§4] Yes / No / Unknown — never force an answer, never assume one */
const TriChip = ({ value, onChange, label }) => (
  <div className="flex items-center justify-between gap-3 py-1.5">
    <span className="text-sm">{label}</span>
    <div className="flex rounded-lg border overflow-hidden shrink-0" style={{ borderColor: "var(--line)" }}>
      {[[true, "Yes"], [false, "No"], ["unknown", "Not sure"]].map(([v, t]) => (
        <button key={t} onClick={() => onChange(v)}
          className={`px-2.5 py-1 text-xs ${value === v ? "chip-on" : "chip-off"}`}
          style={{ borderRadius: 0 }}>{t}</button>
      ))}
    </div>
  </div>
);

const ToggleChip = ({ on, onClick, children }) => (
  <button onClick={onClick} className={`px-3 py-1.5 rounded-full text-sm border transition-colors ${on ? "chip-on" : "chip-off"}`}>
    {on && <Check size={13} className="inline mr-1 -mt-0.5" />}{children}
  </button>
);
const PriorityBadge = ({ level }) => {
  const map = { High: "badge-high", Medium: "badge-med", Low: "badge-low", Covered: "badge-ok" };
  return <span className={`text-xs px-2 py-0.5 rounded-full font-medium tracking-wide ${map[level] || "badge-low"}`}>{String(level).toUpperCase()}</span>;
};
const Spinner = ({ label }) => (
  <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: "var(--mute)" }}>
    <Loader2 size={12} className="animate-spin" /> {label}
  </span>
);
const GapBar = ({ nowv, target }) => {
  const pct = target > 0 ? Math.min(100, Math.round((nowv / target) * 100)) : 100;
  const gap = Math.max(0, target - nowv);
  return (
    <div className="mt-3">
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--line)" }}>
        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, background: pct >= 100 ? "var(--leaf)" : pct >= 50 ? "var(--gold)" : "var(--red)" }} />
      </div>
      <div className="flex justify-between mt-1.5 text-xs" style={{ color: "var(--mute)" }}>
        <span>Current {fmt(nowv)}</span>
        {gap > 0 ? <span style={{ color: "var(--red)" }} className="font-medium">Gap {fmt(gap)}</span>
          : <span style={{ color: "var(--leaf)" }} className="font-medium">Fully covered</span>}
        <span>Target {fmt(target)}</span>
      </div>
    </div>
  );
};

/* --- signature element: the actuarial dial, in hero and mini sizes --- */
const dialGeom = (score) => {
  const angle = 180 - score * 1.8;
  const rad = (a) => (a * Math.PI) / 180;
  const pt = (a, r) => [100 + r * Math.cos(rad(a)), 96 - r * Math.sin(rad(a))];
  const arc = (a1, a2, r) => { const [x1, y1] = pt(a1, r); const [x2, y2] = pt(a2, r); return `M ${x1} ${y1} A ${r} ${r} 0 0 1 ${x2} ${y2}`; };
  return { angle, pt, arc };
};
const Gauge = ({ score, band }) => {
  const { angle, pt, arc } = dialGeom(score);
  const ticks = [];
  for (let a = 180; a >= 0; a -= 7.5) {
    const major = a % 45 === 0;
    const [x1, y1] = pt(a, major ? 66 : 70); const [x2, y2] = pt(a, 78);
    ticks.push(<line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--pine)" strokeOpacity={major ? 0.8 : 0.3} strokeWidth={major ? 1.6 : 1} />);
  }
  const [nx, ny] = pt(angle, 58);
  return (
    <svg viewBox="0 0 200 118" className="w-56 sm:w-64">
      <path d={arc(180, 99, 84)} stroke="var(--red)" strokeWidth="7" fill="none" strokeLinecap="round" opacity="0.85" />
      <path d={arc(99, 45, 84)} stroke="var(--gold)" strokeWidth="7" fill="none" opacity="0.85" />
      <path d={arc(45, 0, 84)} stroke="var(--leaf)" strokeWidth="7" fill="none" strokeLinecap="round" opacity="0.9" />
      {ticks}
      <line x1="100" y1="96" x2={nx} y2={ny} stroke="var(--ink)" strokeWidth="2.5" strokeLinecap="round" className="needle" />
      <circle cx="100" cy="96" r="5" fill="var(--pine)" /><circle cx="100" cy="96" r="2" fill="var(--gold)" />
      <text x="100" y="88" textAnchor="middle" className="gauge-num" fill="var(--ink)">{score}</text>
      <text x="100" y="112" textAnchor="middle" fontSize="9" letterSpacing="1.5" fill="var(--mute)">{band.toUpperCase()}</text>
    </svg>
  );
};
const MiniGauge = ({ value, label, invert = false }) => {
  const { angle, pt, arc } = dialGeom(value);
  const segs = invert
    ? [[180, 99, "var(--leaf)"], [99, 45, "var(--gold)"], [45, 0, "var(--red)"]]
    : [[180, 99, "var(--red)"], [99, 45, "var(--gold)"], [45, 0, "var(--leaf)"]];
  const bandTxt = invert ? (value <= 35 ? "LOW" : value <= 65 ? "MODERATE" : "HIGH")
    : (value >= 75 ? "STRONG" : value >= 45 ? "BUILDING" : "WEAK");
  const [nx, ny] = pt(angle, 56);
  return (
    <div className="flex flex-col items-center rounded-xl border p-3" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <svg viewBox="0 0 200 118" className="w-32 sm:w-36">
        {segs.map(([a1, a2, col], i) => <path key={i} d={arc(a1, a2, 82)} stroke={col} strokeWidth="8" fill="none" strokeLinecap={i !== 1 ? "round" : "butt"} opacity="0.9" />)}
        <line x1="100" y1="96" x2={nx} y2={ny} stroke="var(--ink)" strokeWidth="2.2" strokeLinecap="round" className="needle" />
        <circle cx="100" cy="96" r="4" fill="var(--pine)" />
        <text x="100" y="86" textAnchor="middle" fontFamily="Fraunces,Georgia,serif" fontWeight="700" fontSize="24" fill="var(--ink)">{value}</text>
        <text x="100" y="112" textAnchor="middle" fontSize="8.5" letterSpacing="1.2" fill="var(--mute)">{bandTxt}</text>
      </svg>
      <div className="text-xs font-medium mt-1 text-center" style={{ color: "var(--ink)" }}>{label}</div>
    </div>
  );
};

/* =========================== §7 FEATURE COMPONENTS ============================ */

/* --- Recommendation card with explainability drawer (feature 9) --- */
/* [P3] Waiting Period Advisor — buy-today vs buy-at-45 timeline. Pure flex bars, no libs. */
const WaitingPeriodTimeline = ({ age, canPort, existingL }) => {
  const a = Math.min(44, Math.max(18, age));
  const Row = ({ label, segs }) => (
    <div className="flex items-center gap-2 mt-1.5">
      <div className="w-24 text-xs shrink-0" style={{ color: "var(--mute)" }}>{label}</div>
      <div className="flex-1 flex h-4 rounded overflow-hidden border" style={{ borderColor: "var(--line)" }}>
        {segs.map(([flex, bg, txt], i) => (
          <div key={i} className="flex items-center justify-center text-[10px] whitespace-nowrap overflow-hidden" style={{ flex, background: bg, color: txt ? "#fff" : "transparent" }}>{txt || ""}</div>
        ))}
      </div>
    </div>
  );
  return (
    <div className="mt-3 rounded-lg p-3" style={{ background: "#F0F5F2" }}>
      <div className="text-xs font-semibold" style={{ color: "var(--pine)" }}>Waiting-period advisor · why timing beats price</div>
      <Row label={`Buy at ${a} (now)`} segs={[[3, "var(--gold)", "≤3-yr PED wait"], [Math.max(4, 62 - a - 3), "var(--leaf)", "covered for life"]]} />
      <Row label="Buy at 45" segs={[[Math.max(2, 45 - a), "#E5B8B4", `${45 - a} yrs unprotected`], [3, "var(--gold)", "wait ends at 48"], [14, "var(--leaf)", "covered"]]} />
      <p className="text-[11px] mt-2 leading-relaxed" style={{ color: "#33443C" }}>
        Pre-existing-disease waiting — capped at 3 years under current IRDAI norms — only runs while you hold a policy; health cover is lifelong-renewable once in. Delay to 45 and the wait ends by 48, exactly when claims typically begin.
        {canPort && <> You already hold {fmt(existingL * L)}: <b>port + enhance</b> at renewal (apply ≥45 days before) and the served wait carries over — buying fresh restarts the clock.</>}
      </p>
    </div>
  );
};

/* [§16] Options, not verdicts: flat vs layered with honest pros/cons — recommendation explained, not imposed. */
const OptionsCompare = ({ h }) => (
  <div className="mt-3 grid sm:grid-cols-2 gap-2 text-xs">
    {[{
      t: "Option A — flat " + fmt(h.cover), cost: h.flatCost, rec: h.structure === "flat",
      pros: "One policy, one claim, simplest paperwork.",
      cons: "Premium climbs with age on the full amount" + (h.save ? `; ≈ ${fmt(h.save)}/yr costlier here` : "") + ".",
    }, {
      t: "Option B — " + fmt(h.base) + " base + " + fmt(h.topUp) + " top-up", cost: h.structCost, rec: h.structure === "topup",
      pros: "Same big-event protection, top-up layer prices at ~25–30% of base rates.",
      cons: "Two policies; the deductible must exactly match the base; claims above " + fmt(h.base) + " touch both.",
    }].map((o) => (
      <div key={o.t} className="rounded-lg border p-3" style={{ borderColor: o.rec ? "var(--leaf)" : "var(--line)", background: o.rec ? "#F0F7F3" : "#FAFCFB" }}>
        <div className="font-semibold flex items-center justify-between" style={{ color: "var(--pine)" }}>{o.t}{o.rec && <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ background: "var(--leaf)", color: "#fff" }}>LIKELY SUITABLE</span>}</div>
        <div className="tnum mt-0.5" style={{ color: "var(--mute)" }}>≈ {fmt(o.cost)}/yr indicative</div>
        <div className="mt-1"><b>Pros:</b> {o.pros}</div>
        <div className="mt-0.5"><b>Cons:</b> {o.cons}</div>
      </div>
    ))}
  </div>
);

/* [§11] Returning customer: score movement + what changed and why, before anything else. */
const WhatChangedStrip = ({ d }) => (
  <section className="rounded-xl border p-4 mt-4 card-in" style={{ background: "#F0F7F3", borderColor: "var(--leaf)" }}>
    <div className="text-xs font-semibold tracking-widest" style={{ color: "var(--pine)" }}>SINCE YOUR LAST VISIT · {new Date(d.prevTs).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</div>
    <div className="flex items-baseline gap-2 mt-1">
      <span className="serif text-2xl tnum">{d.prevScore}</span>
      <span style={{ color: "var(--mute)" }}>→</span>
      <span className="serif text-2xl tnum" style={{ color: d.score >= d.prevScore ? "#1F7A4F" : "var(--gold-deep)" }}>{d.score}</span>
      <span className="text-xs" style={{ color: "var(--mute)" }}>indicative protection score</span>
    </div>
    {d.why.length > 0 && <div className="text-xs mt-1.5" style={{ color: "#33443C" }}><b>What changed:</b> {d.why.join(" · ")}</div>}
    {d.changes.length > 0 && <div className="text-xs mt-1" style={{ color: "#33443C" }}><b>Targets moved:</b> {d.changes.join(" · ")}</div>}
    {d.why.length === 0 && d.changes.length === 0 && <div className="text-xs mt-1.5" style={{ color: "#33443C" }}>Profile unchanged — same plan, re-confirmed.</div>}
  </section>
);

/* [P5] Protection affordability strip — premium load vs the 5–6% of income norm. */
const AffordabilityStrip = ({ c, onOptimize }) => {
  const a = c.afford;
  const cfg = a.status === "green" ? ["#DFF2E8", "#1F7A4F", "Comfortable"] : a.status === "yellow" ? ["#F7EBD4", "var(--gold-deep)", "Stretch — sequence it"] : ["#F8E3E1", "#A5322B", "Over budget — prioritise"];
  return (
    <section className="rounded-xl border p-4 mt-4 card-in flex flex-wrap items-center gap-x-6 gap-y-2" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <div>
        <div className="text-xs font-semibold tracking-widest" style={{ color: "var(--mute)" }}>PROTECTION AFFORDABILITY</div>
        <div className="text-sm mt-0.5">Full plan ≈ <b className="tnum">{fmt(a.lo)}–{fmt(a.hi)}/yr</b> on <b className="tnum">{fmt(c.income)}</b> income</div>
      </div>
      <div className="flex items-center gap-2">
        <span className="serif text-2xl tnum">{a.pct}%</span>
        <span className="text-xs px-2 py-1 rounded-full font-medium" style={{ background: cfg[0], color: cfg[1] }}>{cfg[2]}</span>
      </div>
      <div className="text-xs" style={{ color: "var(--mute)" }}>Broker norm for pure protection: ~5–6% of income.</div>
      {a.status !== "green" && (
        <button onClick={() => onOptimize(a.budgetSuggest)} className="ml-auto text-sm px-3 py-1.5 rounded-lg text-white" style={{ background: "var(--pine)" }}>
          Optimize for {fmt(a.budgetSuggest)}/yr
        </button>
      )}
    </section>
  );
};

/* [P7] Score transparency panel — weights on the table, no lab coat. */
const ScoreCalc = ({ c }) => (
  <div className="mt-3 rounded-lg p-3 text-xs leading-relaxed" style={{ background: "#F0F5F2", color: "#33443C" }}>
    <b style={{ color: "var(--pine)" }}>How this score is calculated.</b> A weighted blend of indicators representing financial impact and protection adequacy — indicative, not actuarially precise.
    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
      {c.scoreWeights.map(([n, w]) => <span key={n} className="tnum"><b>{w}</b> · {n}</span>)}
    </div>
    <div className="mt-2">Lifestyle factors deduct up to 8 points while the critical-illness gap stays open. Confidence: <PriorityBadge level={c.scoreConfidence} /> — profile {c.completeness.pct}% complete{c.completeness.missing.length ? `; unanswered: ${c.completeness.missing.slice(0, 4).join(", ")}${c.completeness.missing.length > 4 ? "…" : ""}` : ""}. {c.unknownFactors.length ? "Unknowns never count as No — they lower confidence instead." : ""}</div>
  </div>
);

const RecCard = ({ icon: Icon, name, priority, amount, sub, reason, bar, meta, delayMs, extra }) => {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border p-5 card-in flex flex-col" style={{ background: "var(--card)", borderColor: "var(--line)", animationDelay: `${delayMs}ms` }}>
      <div className="flex items-start justify-between mb-1">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#EAF2ED" }}>
            <Icon size={16} style={{ color: "var(--pine)" }} />
          </div>
          <h3 className="font-semibold text-sm">{name}</h3>
        </div>
        <PriorityBadge level={priority} />
      </div>
      <div className="serif text-3xl tnum mt-2" style={{ color: "var(--ink)" }}>{amount}</div>
      <div className="text-xs mt-0.5" style={{ color: "var(--mute)" }}>{sub}</div>
      <p className="text-sm leading-relaxed mt-3 flex-1" style={{ color: "#33443C" }}>{reason || "…"}</p>
      {bar && <GapBar nowv={bar.now} target={bar.target} />}
      {extra /* [P3][P6] slot: waiting-period timeline, homemaker callout, senior-caution note */}
      {meta && (
        <div className="mt-3 pt-3 border-t" style={{ borderColor: "var(--line)" }}>
          <button onClick={() => setOpen(!open)} className="text-xs font-medium flex items-center gap-1" style={{ color: "var(--pine)" }}>
            <ChevronDown size={13} className={`transition-transform ${open ? "rotate-180" : ""}`} /> Why this number
          </button>
          {open && (
            <div className="mt-2 text-xs leading-relaxed space-y-2" style={{ color: "#33443C" }}>
              <div><span className="font-semibold" style={{ color: "var(--mute)" }}>BUSINESS LOGIC · </span><span className="mono">{meta.formula}</span></div>
              <div><span className="font-semibold" style={{ color: "var(--mute)" }}>CONFIDENCE · </span><PriorityBadge level={meta.confidence} /> <span className="ml-1">{meta.confWhy}</span></div>
              <div><span className="font-semibold" style={{ color: "var(--mute)" }}>ALTERNATIVE · </span>{meta.alternative}</div>
              {meta.risks && meta.risks !== "—" && <div><span className="font-semibold" style={{ color: "var(--mute)" }}>RISKS · </span>{meta.risks}</div>}
              {meta.changesWhen && <div><span className="font-semibold" style={{ color: "var(--mute)" }}>REVIEW WHEN · </span>{meta.changesWhen}</div>} {/* [§9] */}
              {meta.assumptions && <div><span className="font-semibold" style={{ color: "var(--mute)" }}>ASSUMPTIONS · </span>{meta.assumptions}</div>}
              {meta.changesWhen && <div><span className="font-semibold" style={{ color: "var(--mute)" }}>CHANGES WHEN · </span>{meta.changesWhen}</div>}
            </div>
          )}
        </div>
      )}
    </section>
  );
};

/* --- Coverage Gap Dashboard (feature 3) --- */
const GapTable = ({ p, c }) => {
  const rows = useMemo(() => gapRows(p, c), [p, c]);
  const totLo = rows.reduce((s, r) => s + (r.costLo || 0), 0);
  const totHi = rows.reduce((s, r) => s + (r.costHi || 0), 0);
  return (
    <div className="rounded-xl border overflow-hidden card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <div className="px-5 py-3 border-b flex flex-wrap items-baseline gap-x-3 gap-y-1" style={{ borderColor: "var(--line)" }}>
        <h3 className="font-semibold text-sm">Coverage gap analysis</h3>
        <span className="text-xs ml-auto" style={{ color: "var(--mute)" }}>
          Closing every gap ≈ <b style={{ color: "var(--ink)" }}>{fmt(totLo)}–{fmt(totHi)}/yr</b>{c.income > 0 && <> ({(totHi / c.income * 100).toFixed(1)}% of income at most)</>}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ minWidth: 640 }}>
          <thead>
            <tr className="text-xs" style={{ color: "var(--mute)" }}>
              {["Cover", "Current", "Recommended", "Gap", "Priority", "Financial exposure", "Cost to close /yr (indicative)"].map((h) => (
                <th key={h} className="text-left font-medium px-4 py-2.5 border-b" style={{ borderColor: "var(--line)" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                <td className="px-4 py-2.5 font-medium">{r.name}</td>
                <td className="px-4 py-2.5 tnum">{r.motor ? (c.motor.status === "uninsured" ? "Uninsured" : "Third-party") : fmt(r.now)}</td>
                <td className="px-4 py-2.5 tnum">{r.motor ? "Comprehensive" : fmt(r.rec)}</td>
                <td className="px-4 py-2.5 tnum font-semibold" style={{ color: (r.gap > 0 || r.motor) ? "var(--red)" : "var(--leaf)" }}>{r.motor ? "Policy" : r.gap > 0 ? fmt(r.gap) : "None"}</td>
                <td className="px-4 py-2.5"><PriorityBadge level={r.gap > 0 || r.motor ? r.priority : "Covered"} /></td>
                <td className="px-4 py-2.5 text-xs" style={{ color: "#33443C" }}>{typeof r.exposure === "string" ? r.exposure : r.exposure > 0 ? `${fmt(r.exposure)} out-of-pocket in a bad event` : "Protected"}</td>
                <td className="px-4 py-2.5 tnum text-xs">{r.costLo || r.costHi ? `${fmt(r.costLo)}–${fmt(r.costHi)}` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* --- Budget Optimizer (features 4 + 8) --- */
const BudgetOptimizer = ({ p, c, seed }) => {
  const [budget, setBudget] = useState(seed ? String(seed) : "30000");
  useEffect(() => { if (seed) setBudget(String(seed)); }, [seed]); /* [P5] affordability handoff */
  const result = useMemo(() => optimizeBudget(p, c, num(budget)), [p, c, budget]);
  const allocTotal = result.rows.reduce((s, r) => s + r.alloc, 0);
  return (
    <div className="rounded-xl border p-5 card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <h3 className="font-semibold text-sm mb-1">Budget optimizer</h3>
      <p className="text-xs mb-4" style={{ color: "var(--mute)" }}>
        Enter your annual insurance budget — the engine funds gaps in priority order (legal musts → health → parents → term → PA → CI) using indicative premium midpoints. Closing everything needs <b style={{ color: "var(--ink)" }}>{fmt(result.needLo)}–{fmt(result.needHi)}/yr</b>.
      </p>
      <div className="flex flex-wrap items-end gap-3 mb-4">
        <div className="w-48"><Field label="Annual budget" hint="₹"><NumInput value={budget} onChange={setBudget} placeholder="30000" /></Field></div>
        <div className="mb-4 text-xs" style={{ color: "var(--mute)" }}>Allocated <b style={{ color: "var(--ink)" }}>{fmt(allocTotal)}</b> · Buffer left <b style={{ color: "var(--leaf)" }}>{fmt(result.leftover)}</b></div>
      </div>
      {allocTotal > 0 && (
        <div className="h-3 rounded-full overflow-hidden flex mb-4" style={{ background: "var(--line)" }}>
          {result.rows.filter((r) => r.alloc > 0).map((r, i) => (
            <div key={r.name} title={`${r.name}: ${fmt(r.alloc)}`} style={{ width: `${(r.alloc / Math.max(1, num(budget))) * 100}%`, background: ["var(--pine)", "var(--leaf)", "var(--gold)", "#6B9E88", "#A2681B", "#3E5C4F"][i % 6] }} />
          ))}
        </div>
      )}
      <div className="space-y-2">
        {result.rows.map((r) => (
          <div key={r.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm border-b pb-2 last:border-0" style={{ borderColor: "var(--line)" }}>
            <span className="font-medium w-56">{r.name}</span>
            <span className="tnum" style={{ color: r.alloc ? "var(--ink)" : "var(--mute)" }}>{r.alloc ? fmt(r.alloc) + "/yr" : "₹0"}</span>
            <span className="text-xs" style={{ color: "var(--mute)" }}>→ {r.bought}</span>
            {r.note && <span className="text-xs" style={{ color: "var(--gold-deep)" }}>{r.note}</span>}
          </div>
        ))}
        {result.rows.length === 0 && <p className="text-sm" style={{ color: "var(--leaf)" }}>No gaps to fund — your covers are complete.</p>}
      </div>
      {result.leftover > 0 && result.rows.every((r) => r.left === 0 || r.left === undefined) && (
        <p className="text-xs mt-3" style={{ color: "var(--mute)" }}>Surplus {fmt(result.leftover)} → route to the emergency fund, not to investment-linked insurance.</p>
      )}
    </div>
  );
};

/* --- Life Event Simulator (feature 5) --- */
const LifeEventSim = ({ p, c, onApply }) => {
  const [sel, setSel] = useState([]);
  const toggle = (k) => setSel((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const simProfile = useMemo(() => sel.reduce((acc, k) => LIFE_EVENTS.find((e) => e.k === k).apply(acc), p), [sel, p]);
  const sim = useMemo(() => computePlan(simProfile), [simProfile]);
  const deltas = [
    ["Term life cover", c.term.needed ? c.term.cover : 0, sim.term.needed ? sim.term.cover : 0],
    ["Health cover (self/family)", c.health.cover, sim.health.cover],
    ["Parents' plan", c.health.parentsPlan, sim.health.parentsPlan],
    ["Critical illness", c.critical.cover, sim.critical.cover],
    ["Personal accident", c.accident.cover, sim.accident.cover],
    ["Protection score", c.score, sim.score],
  ];
  return (
    <div className="rounded-xl border p-5 card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <h3 className="font-semibold text-sm mb-1">Life event simulator</h3>
      <p className="text-xs mb-4" style={{ color: "var(--mute)" }}>Tap events to see your plan re-price instantly — the rules engine recomputes live, no waiting on AI.</p>
      <div className="flex flex-wrap gap-2 mb-4">
        {LIFE_EVENTS.map(({ k, label, icon: Icon }) => (
          <button key={k} onClick={() => toggle(k)} className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm border transition-colors ${sel.includes(k) ? "chip-on" : "chip-off"}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {sel.length > 0 ? (
        <>
          <div className="overflow-x-auto rounded-lg border" style={{ borderColor: "var(--line)" }}>
            <table className="w-full text-sm" style={{ minWidth: 480 }}>
              <thead><tr className="text-xs" style={{ color: "var(--mute)" }}>
                <th className="text-left font-medium px-4 py-2 border-b" style={{ borderColor: "var(--line)" }}>Metric</th>
                <th className="text-left font-medium px-4 py-2 border-b" style={{ borderColor: "var(--line)" }}>Today</th>
                <th className="text-left font-medium px-4 py-2 border-b" style={{ borderColor: "var(--line)" }}>After events</th>
                <th className="text-left font-medium px-4 py-2 border-b" style={{ borderColor: "var(--line)" }}>Change</th>
              </tr></thead>
              <tbody>
                {deltas.map(([name, a, b]) => {
                  const isScore = name === "Protection score";
                  const d = b - a;
                  return (
                    <tr key={name} className="border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                      <td className="px-4 py-2 font-medium">{name}</td>
                      <td className="px-4 py-2 tnum">{isScore ? a : fmt(a)}</td>
                      <td className="px-4 py-2 tnum">{isScore ? b : fmt(b)}</td>
                      <td className="px-4 py-2 tnum font-semibold" style={{ color: d === 0 ? "var(--mute)" : (isScore ? d > 0 : d < 0) ? "var(--leaf)" : "var(--gold-deep)" }}>
                        {d === 0 ? "—" : (d > 0 ? "▲ " : "▼ ") + (isScore ? Math.abs(d) : fmt(Math.abs(d)))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-3 space-y-1.5">
            {sel.map((k) => { const e = LIFE_EVENTS.find((x) => x.k === k); return (
              <p key={k} className="text-xs flex gap-1.5" style={{ color: "#33443C" }}><e.icon size={13} style={{ color: "var(--pine)", flexShrink: 0, marginTop: 1 }} /> <span><b>{e.label}:</b> {e.note} <span style={{ color: "var(--pine)" }}>{e.next}</span></span></p>
            ); })}
          </div>
          <div className="flex gap-2 mt-4">
            <button onClick={() => onApply(simProfile)} className="text-sm px-4 py-2 rounded-lg text-white" style={{ background: "var(--pine)" }}>Apply to my profile</button>
            <button onClick={() => setSel([])} className="text-sm px-4 py-2 rounded-lg border chip-off">Reset</button>
          </div>
        </>
      ) : <p className="text-sm" style={{ color: "var(--mute)" }}>Select one or more events above.</p>}
    </div>
  );
};

/* --- Insurance Roadmap (feature 10) --- */
const Roadmap = ({ p, c }) => {
  const ms = useMemo(() => buildRoadmap(p, c), [p, c]);
  return (
    <div className="rounded-xl border p-5 card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <h3 className="font-semibold text-sm mb-4">Your insurance roadmap</h3>
      <div className="relative pl-6">
        <div className="absolute left-1.5 top-1 bottom-1 w-px" style={{ background: "var(--line)" }} />
        {ms.map((m, i) => (
          <div key={m.when} className="relative pb-5 last:pb-0">
            <div className="absolute -left-6 top-1 w-3 h-3 rounded-full border-2" style={{ background: i === 0 ? "var(--gold)" : "var(--card)", borderColor: i === 0 ? "var(--gold)" : "var(--pine)" }} />
            <div className="text-xs font-semibold tracking-widest" style={{ color: "var(--gold-deep)" }}>{m.when.toUpperCase()}</div>
            <div className="serif text-lg" style={{ color: "var(--pine)" }}>{m.title}</div>
            <ul className="mt-1 space-y-1">
              {m.points.map((pt, j) => <li key={j} className="text-sm leading-relaxed flex gap-1.5" style={{ color: "#33443C" }}><Check size={13} style={{ color: "var(--leaf)", flexShrink: 0, marginTop: 3 }} />{pt}</li>)}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
};

/* --- Policy Analyzer (feature 7) — upload a policy PDF, Claude extracts terms --- */
const PolicyAnalyzer = ({ p, c }) => {
  const [state, setState] = useState("idle"); // idle | reading | analyzing | done | error
  const [result, setResult] = useState(null);
  const [errMsg, setErrMsg] = useState("");
  const fileRef = useRef(null);

  const analyze = async (file) => {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) { setErrMsg("PDF is over 6 MB — export a smaller copy and retry."); setState("error"); return; }
    setState("reading"); setErrMsg(""); setResult(null);
    try {
      const base64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.onerror = () => rej(new Error("Could not read the file"));
        r.readAsDataURL(file);
      });
      setState("analyzing");
      const text = await callClaude([{
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
          { type: "text", text: `You are an insurance policy auditor at ${BRAND}, India. Extract the key terms of this policy. The customer's recommended health cover is ${fmt(c.health.cover)}. Respond with ONLY valid JSON, no markdown:
{"policyType":"","sumInsuredL":0,"waitingInitialDays":"","waitingPreExistingMonths":"","roomRent":"","copayOrDeductible":"","subLimits":["max 4 items"],"exclusions":["top 5 only"],"missingBenefits":["max 5 — benefits a good modern policy has but this one lacks"],"upgrade":"2-3 sentence upgrade recommendation","verdict":"Keep" or "Upgrade" or "Replace"}
sumInsuredL must be a number in ₹ lakhs. Keep every string under 20 words. Report ONLY what the document states — if a term is absent, write "not stated"; never estimate or invent figures. Phrase the upgrade as "likely" and "subject to insurer underwriting"; never name other insurers or products. [FIX F12]` },
        ],
      }]);
      setResult(parseJson(text));
      setState("done");
    } catch (e) {
      setErrMsg("Analysis failed — the file may be scanned/unreadable, or the AI is unreachable. Try again.");
      setState("error");
    }
  };

  const KV = ({ k, v }) => (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: "var(--line)" }}>
      <div className="text-xs" style={{ color: "var(--mute)" }}>{k}</div>
      <div className="text-sm font-medium">{v || "Not found"}</div>
    </div>
  );
  const List = ({ title, items, tone }) => (
    <div>
      <div className="text-xs font-semibold tracking-wider mb-1.5" style={{ color: tone === "bad" ? "var(--red)" : "var(--mute)" }}>{title}</div>
      <ul className="space-y-1">{(items || []).map((x, i) => <li key={i} className="text-sm flex gap-1.5" style={{ color: "#33443C" }}><X size={13} style={{ color: tone === "bad" ? "var(--red)" : "var(--gold-deep)", flexShrink: 0, marginTop: 3 }} />{x}</li>)}</ul>
      {(!items || !items.length) && <p className="text-sm" style={{ color: "var(--mute)" }}>None found.</p>}
    </div>
  );

  return (
    <div className="rounded-xl border p-5 card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <h3 className="font-semibold text-sm mb-1">Policy analyzer</h3>
      <p className="text-xs mb-4" style={{ color: "var(--mute)" }}>Upload an existing policy PDF — Claude reads it and extracts the terms that decide whether a claim actually pays.</p>
      <input ref={fileRef} type="file" accept="application/pdf" className="hidden" onChange={(e) => analyze(e.target.files?.[0])} />
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={() => fileRef.current?.click()} disabled={state === "reading" || state === "analyzing"}
          className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg text-white disabled:opacity-50" style={{ background: "var(--pine)" }}>
          <FileText size={14} /> {state === "done" ? "Analyze another PDF" : "Upload policy PDF"}
        </button>
        {state === "reading" && <Spinner label="Reading file…" />}
        {state === "analyzing" && <Spinner label="Claude is auditing the policy…" />}
        {state === "error" && <span className="text-xs flex items-center gap-1" style={{ color: "var(--red)" }}><AlertTriangle size={12} />{errMsg}</span>}
      </div>
      {state === "done" && result && (
        <div className="mt-5 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-xs px-2.5 py-1 rounded-full font-semibold ${result.verdict === "Keep" ? "badge-ok" : result.verdict === "Upgrade" ? "badge-high" : "badge-risk"}`}>VERDICT: {String(result.verdict).toUpperCase()}</span>
            {result.sumInsuredL > 0 && result.sumInsuredL * L < c.health.cover && (
              <span className="text-xs px-2.5 py-1 rounded-full badge-risk">Sum insured {fmt(result.sumInsuredL * L)} is below your recommended {fmt(c.health.cover)}</span>
            )}
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <KV k="Policy type" v={result.policyType} />
            <KV k="Sum insured" v={result.sumInsuredL ? fmt(result.sumInsuredL * L) : ""} />
            <KV k="Initial waiting" v={result.waitingInitialDays} />
            <KV k="Pre-existing waiting" v={result.waitingPreExistingMonths} />
            <KV k="Room rent limit" v={result.roomRent} />
            <KV k="Co-pay / deductible" v={result.copayOrDeductible} />
          </div>
          <div className="grid md:grid-cols-3 gap-4">
            <List title="SUB-LIMITS" items={result.subLimits} />
            <List title="KEY EXCLUSIONS" items={result.exclusions} tone="bad" />
            <List title="MISSING BENEFITS" items={result.missingBenefits} tone="bad" />
          </div>
          <div className="rounded-lg px-4 py-3" style={{ background: "#F0F5F2" }}>
            <div className="text-xs font-semibold tracking-wider mb-1" style={{ color: "var(--pine)" }}>UPGRADE RECOMMENDATION</div>
            <p className="text-sm leading-relaxed" style={{ color: "#33443C" }}>{result.upgrade}</p>
          </div>
        </div>
      )}
    </div>
  );
};

/* --- AI Insurance Coach (feature 6) --- */
const Coach = ({ p, c }) => {
  const [chat, setChat] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chat, busy]);
  const suggestions = ["Should I increase my cover?", "Is employer insurance enough?", "What if I change jobs?", "Can I remove my parents from my plan?", "What happens if I buy a house?"];
  const send = async (textArg) => {
    const text = (textArg ?? input).trim();
    if (!text || busy) return;
    const history = [...chat, { role: "user", content: text }];
    setChat(history); setInput(""); setBusy(true);
    try {
      const context = `You are the AI Insurance Coach at ${BRAND}, India, advising ${p.name || "the client"}. You remember their full profile: ${profileSummary(p, c)}. Their computed plan: ${planSummary(c)}.
Rules: answer in under 130 words, plain English, ₹ lakhs/crores. If they mention a life event (marriage, child, house/loan, job change), state exactly which covers change and to what amounts, and tell them the Simulator tab can preview it. Never name specific insurers or products. No absolutes ("everyone should") — use "based on your profile", "likely suitable", "subject to insurer underwriting" [P12]. Use ONLY figures from the profile/plan above — never invent premiums, statistics, or regulation citations; PED waiting is capped at 3 years. If asked which insurer or product to buy, decline names and explain the broker shortlists insurers after underwriting [FIX F12]. Where relevant, explain the base + super top-up structure, PORT + enhance for existing policies, waiting periods, and the parents-at-70+ realities (co-pay, loading, possible decline, medical corpus). Educational guidance, not a sale.`;
      const messages = [
        { role: "user", content: context },
        { role: "assistant", content: `Understood. I remember ${p.name || "the client"}'s profile and plan. Ready.` },
        ...history.map((m) => ({ role: m.role, content: m.content })),
      ];
      const reply = await callClaude(messages);
      setChat([...history, { role: "assistant", content: reply }]);
    } catch (e) {
      setChat([...history, { role: "assistant", content: "I couldn't reach the AI service just now — your plan above is still valid. Try again in a moment." }]);
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border card-in overflow-hidden" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <div className="px-5 py-3 border-b flex items-center gap-2" style={{ borderColor: "var(--line)" }}>
        <MessageCircle size={16} style={{ color: "var(--pine)" }} />
        <h3 className="font-semibold text-sm">AI Insurance Coach</h3>
        <span className="text-xs ml-auto hidden sm:block" style={{ color: "var(--mute)" }}>remembers {p.name ? p.name.split(" ")[0] + "'s" : "your"} profile · age {c.age} · {fmt(c.income)}/yr</span>
      </div>
      <div className="px-5 py-4 max-h-96 overflow-y-auto">
        {chat.length === 0 && (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => <button key={s} onClick={() => send(s)} className="text-sm px-3 py-1.5 rounded-full border chip-off">{s}</button>)}
          </div>
        )}
        {chat.map((m, i) => (
          <div key={i} className={`my-2 flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] rounded-xl px-3.5 py-2.5 text-sm leading-relaxed whitespace-pre-wrap ${m.role === "user" ? "text-white" : ""}`}
              style={m.role === "user" ? { background: "var(--pine)" } : { background: "#F0F5F2", color: "var(--ink)" }}>{m.content}</div>
          </div>
        ))}
        {busy && <div className="my-2"><Spinner label="Thinking…" /></div>}
        <div ref={endRef} />
      </div>
      <div className="px-5 py-3 border-t flex gap-2" style={{ borderColor: "var(--line)" }}>
        <input className={inputCls + " flex-1"} placeholder="e.g. My child was just born — what changes?" value={input}
          onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button onClick={() => send()} disabled={busy || !input.trim()} className="px-4 rounded-lg text-white disabled:opacity-40 flex items-center" style={{ background: "var(--pine)" }}><Send size={15} /></button>
      </div>
    </div>
  );
};

/* ================================ §8 PAGES ==================================== */

/* ------------------------------- Advisor page -------------------------------- */
function AdvisorPage({ p, setP, plan, setPlan, reasons, setReasons, aiStatus, setAiStatus, phase, setPhase, webhook }) {
  const [step, setStep] = useState(0);
  const [tab, setTab] = useState("overview");
  const steps = ["Contact", "About you", "Family", "Assets & cover", "Health & goals"];
  const set = (k) => (v) => setP((prev) => ({ ...prev, [k]: v }));
  const toggle = (k) => () => setP((prev) => ({ ...prev, [k]: !prev[k] }));
  const toggleGoal = (g) => () => setP((prev) => ({ ...prev, goals: prev.goals.includes(g) ? prev.goals.filter((x) => x !== g) : [...prev.goals, g] }));
  /* [P8] step 0 requires explicit DPDP consent; step 1 requires age + income. */
  const canNext = step === 0 ? !!p.consent : step !== 1 || (num(p.age) >= 18 && num(p.incomeL) > 0);
  const [budgetSeed, setBudgetSeed] = useState(null); /* [P5] affordability → budget handoff */
  const [showCalc, setShowCalc] = useState(false);    /* [P7] score transparency */
  const [showPrivacy, setShowPrivacy] = useState(false); /* [P8] */
  const [delMsg, setDelMsg] = useState("");
  const [lastDiff, setLastDiff] = useState(null); /* [§11] */
  const eraseData = async () => { /* [P8] DPDP right to erasure */
    const n = await deleteMyData(p.email);
    setDelMsg(n > 0 ? `Deleted ${n} stored record${n > 1 ? "s" : ""} for ${p.email} from this app.` : `No stored records found for ${p.email}.`);
  };

  const generate = async (profileArg, capture = false) => { /* [FIX F14] simulator re-runs must not create leads */
    const prof = profileArg || p;
    const persist = capture && !!prof.consent; /* [FIX F15] consent guards EVERY save, not just the first */
    const recId = newId(); /* [§12] every recommendation gets an ID — audit exists even when the lead isn't stored */
    const c = computePlan(prof);
    c.recId = recId; /* [§12] */
    const fb = fallbackReasons(prof, c);
    setPlan(c); setReasons(fb); setPhase("results"); setTab("overview"); setAiStatus("loading");

    /* ---- lead capture (feature 11): storage + optional Sheets sync ---- */
    const lead = {
      id: recId, ts: Date.now(), /* [§12] lead id === recommendation id */
      name: prof.name, email: prof.email, phone: prof.phone,
      inputs: { ...prof },
      score: c.score, band: c.band, topGap: c.topGap, scores: c.scores,
      recs: { health: c.health.cover, parentsPlan: c.health.parentsPlan, term: c.term.needed ? c.term.cover : 0, pa: c.accident.cover, ci: c.critical.cover },
      aiSummary: fb.overall,
      /* [§12] auditability: every recommendation reproducible to the rule set that made it */
      engineVersion: ENGINE_VERSION, rulesVersion: RULES_VERSION,
      consentVersion: prof.consent ? CONSENT_VERSION : null, consentAt: prof.consentAt || null,
      completenessPct: c.completeness.pct, confidence: c.scoreConfidence,
    };
    if (persist) {
      saveLead(lead); syncToSheets(webhook, lead); /* [P8][FIX F14][FIX F15] */
      /* [§11] returning customers: diff against the last generated plan, then save the new snapshot */
      try {
        const prev = await stGet("snapshot:last");
        if (prev && prev.ts && Date.now() - prev.ts > 60 * 1000) {
          const changes = [];
          const covDiff = (label, a, b) => { if ((a || 0) !== (b || 0)) changes.push(`${label}: ${fmt(a || 0)} → ${fmt(b || 0)}`); };
          covDiff("Health target", prev.recs?.health, c.health.cover);
          covDiff("Term target", prev.recs?.term, c.term.needed && c.term.issuable ? c.term.cover : 0);
          covDiff("Critical illness", prev.recs?.ci, c.critical.cover);
          covDiff("Personal accident", prev.recs?.pa, c.accident.cover);
          const why = [];
          if (num(prof.incomeL) !== prev.incomeL) why.push(`income ${prev.incomeL}L → ${num(prof.incomeL)}L`);
          if (num(prof.loansL) !== prev.loansL) why.push(`loans ${prev.loansL}L → ${num(prof.loansL)}L`);
          if (prof.marital !== prev.marital) why.push(`now ${prof.marital}`);
          if (num(prof.kids) !== prev.kids) why.push(`children ${prev.kids} → ${num(prof.kids)}`);
          setLastDiff({ prevScore: prev.score, prevTs: prev.ts, score: c.score, changes, why });
        } else setLastDiff(null);
        stSet("snapshot:last", { ts: Date.now(), score: c.score, marital: prof.marital, incomeL: num(prof.incomeL), loansL: num(prof.loansL), kids: num(prof.kids), recs: { health: c.health.cover, term: c.term.needed && c.term.issuable ? c.term.cover : 0, ci: c.critical.cover, pa: c.accident.cover }, engineVersion: ENGINE_VERSION });
      } catch (e) { /* snapshot is best-effort */ }
    } else setLastDiff(null);

    /* ---- AI reasoning with cache (feature 15) ---- */
    const cacheKey = "aiReasons:" + hashStr(profileSummary(prof, c) + planSummary(c));
    const cached = await stGet(cacheKey);
    if (cached) { setReasons((prev) => ({ ...prev, ...cached })); setAiStatus("ai"); if (persist) { lead.aiSummary = cached.overall || fb.overall; saveLead(lead); } return; }
    try {
      const prompt = `You are the AI advisor at ${BRAND}, India. A rules engine has computed recommended covers for a client. Write personalised reasoning — warm, plain-English, India-specific, using the client's actual numbers. Never name specific insurers or products.
Tone rules [P12]: no absolutes ("everyone should/needs"); prefer "based on your profile", "considering your income", "likely suitable", "subject to insurer underwriting".
Unknown handling [§4]: healthFlags marked "unknown" are unanswered — never assume yes or no; where relevant, note that answering them firms up sizing and confidence.
Grounding rules [FIX F12]: use ONLY figures present in CLIENT PROFILE / COMPUTED PLAN — never invent premiums, statistics, or regulation citations; omit what isn't provided. Pre-existing-disease waiting is capped at 3 years — never state longer. If asked for insurer or product names, say the broker shortlists insurers after underwriting.
If the plan uses a base + super top-up structure, explain the deductible mechanic and the saving vs a flat policy. If the client can PORT an existing policy, say why porting beats buying new (waiting-period credit). If parents are 70+, be honest about co-pay/loading/possible decline and the medical-corpus fallback.
CLIENT PROFILE: ${profileSummary(prof, c)}
COMPUTED PLAN: ${planSummary(c)}
Respond with ONLY valid JSON, no markdown fences:
{"health":"...","term":"...","accident":"...","critical":"...","motor":"...","emergency":"...","overall":"..."}
Each value 2-4 crisp sentences (max 70 words). "overall": 2-sentence verdict covering the indicative protection score, affordability status, and what to fix first.`;
      const parsed = parseJson(await callClaude([{ role: "user", content: prompt }]));
      setReasons((prev) => ({ ...prev, ...parsed }));
      setAiStatus("ai");
      stSet(cacheKey, parsed);
      if (persist) { lead.aiSummary = parsed.overall || fb.overall; saveLead(lead); }
    } catch (e) { setAiStatus("fallback"); }
  };

  const download = () => {
    const html = buildReport(p, plan, reasons);
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const a = document.createElement("a"); a.href = url; a.download = "Risk-Advisory-Report.html"; a.click();
    URL.revokeObjectURL(url);
  };

  const recCards = plan && [
    { key: "health", icon: HeartPulse, name: "Health Insurance", priority: "High",
      amount: fmt(plan.health.cover),
      sub: (plan.health.structure === "topup"
        ? `${fmt(plan.health.base)} base + ${fmt(plan.health.topUp)} super top-up · deductible ${fmt(plan.health.deductible)} · saves ≈ ${fmt(plan.health.save)}/yr vs flat` /* [P1] */
        : (plan.health.floater ? "Single family-floater policy" : "Single individual policy"))
        + (plan.health.canPort ? " · PORT + enhance" : "")
        + (plan.health.parentsMode === "senior-plan" ? ` · + ${fmt(plan.health.parentsPlan)} parents' plan` : ""),
      bar: { now: plan.health.now, target: plan.health.cover }, meta: plan.health.meta,
      extra: (<>
        {plan.health.topUp > 0 && <OptionsCompare h={plan.health} />} {/* [§16] */}
        {/* [P3][FIX F16] timeline reads the computed plan, never live form state; the buy-at-45 comparison is meaningless past 45 */}
        {plan.age < 45 && <WaitingPeriodTimeline age={plan.age} canPort={plan.health.canPort} existingL={plan.health.existingHealthL} />}
        {plan.health.structure === "topup" && ( /* [§16] options, not absolutes */
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] leading-relaxed">
            <div className="rounded-lg border p-2.5" style={{ borderColor: "var(--line)" }}>
              <b>Option A · flat {fmt(plan.health.cover)}</b>
              <div style={{ color: "#33443C" }}>+ One policy, one claim, simplest paperwork</div>
              <div style={{ color: "#A5322B" }}>− ≈ {fmt(plan.health.save)}/yr costlier for the same protection</div>
            </div>
            <div className="rounded-lg border-2 p-2.5" style={{ borderColor: "var(--leaf)" }}>
              <b>Option B · {fmt(plan.health.base)} + {fmt(plan.health.topUp)} top-up</b> <span className="px-1.5 rounded-full" style={{ background: "#DFF2E8", color: "#1F7A4F" }}>likely suitable</span>
              <div style={{ color: "#33443C" }}>+ Same protection, lower premium; layer scales with inflation</div>
              <div style={{ color: "#A5322B" }}>− Deductible must match base; big claims run through both policies</div>
            </div>
          </div>
        )}
        {plan.health.parentsMode === "senior-caution" && (
          <div className="mt-3 rounded-lg p-3 text-xs leading-relaxed" style={{ background: "#F7EBD4", color: "var(--gold-deep)" }}>
            <b>Parents at {plan.parentAge} — underwriting caution.</b> Fresh cover typically carries 10–30% (sometimes higher) co-pay, premium loadings, up to 3-yr waiting on pre-existing conditions, and may be declined. Plan: attempt {fmt(plan.health.parentsPlan)} cover <i>and</i> build a {fmt(plan.health.parentsCorpus)} medical corpus, with family support aligned. Confidence: Medium. {/* [P2] */}
          </div>
        )}
      </>) },
    { key: "term", icon: Umbrella, name: "Term Life Insurance", priority: plan.term.priority,
      amount: !plan.term.issuable && !plan.term.now ? "—" : fmt(plan.term.cover),
      sub: (!plan.term.issuable ? "Past typical entry age — corpus-first strategy" : plan.term.loansOnly ? "Loan protection — keeps debt off your estate" : plan.term.needed ? "Pure income replacement, till age 60–65" : "Optional — lock a low premium early") + (plan.term.capped ? " · capped at issuance limit" : ""), /* [FIX F2][FIX F3] */
      bar: plan.term.issuable && plan.term.needed ? { now: plan.term.now, target: plan.term.cover } : null, meta: plan.term.meta, /* [FIX F2] no misleading bar past entry age */
      extra: (<>
        {plan.term.issuable && plan.term.needed && plan.income > 0 && (
          <p className="mt-2 text-xs" style={{ color: "var(--mute)" }}>
            In plain terms: roughly <b style={{ color: "var(--ink)" }}>{Math.round(plan.term.cover / plan.income)} years</b> of your family's income if you're not there to earn it. {/* [§15] numbers → story */}
          </p>
        )}
        {plan.term.spouseCover ? (
          <div className="mt-3 rounded-lg p-3 text-xs leading-relaxed" style={{ background: "#F0F5F2", color: "#33443C" }}>
            <b style={{ color: "var(--pine)" }}>Homemaker spouse: {fmt(plan.term.spouseCover)}.</b> Sized on replacement value — childcare, household management and coordination the family would have to hire — not on income. Most households never price this gap. {/* [P6] */}
          </div>
        ) : null}
      </>) },
    { key: "accident", icon: ShieldAlert, name: "Personal Accident", priority: plan.accident.priority, amount: fmt(plan.accident.cover), sub: "Accidental death + total & partial disability", bar: { now: plan.accident.now, target: plan.accident.cover }, meta: plan.accident.meta },
    { key: "critical", icon: Activity, name: "Critical Illness", priority: plan.critical.priority, amount: fmt(plan.critical.cover), sub: "Lump sum on diagnosis · income replacement", bar: { now: plan.critical.now, target: plan.critical.cover }, meta: plan.critical.meta },
    { key: "motor", icon: Car, name: "Motor Insurance", priority: !plan.motor.hasVehicle ? "Low" : plan.motor.status === "covered" ? "Covered" : "High", amount: plan.motor.hasVehicle ? "Comprehensive" : "Not needed", sub: !plan.motor.hasVehicle ? "You don't own a vehicle" : plan.motor.zeroDep ? "Add zero-depreciation (vehicle < 5 yrs)" : "Own-damage + third-party liability", bar: null, meta: plan.motor.meta },
    { key: "emergency", icon: Wallet, name: "Emergency Fund", priority: plan.emergency.gap > 0 ? "High" : "Covered", amount: fmt(plan.emergency.target), sub: `${plan.emergency.months} months of expenses, liquid — before any investment product`, bar: { now: plan.emergency.now, target: plan.emergency.target }, meta: plan.emergency.meta },
  ];

  const TABS = [
    ["overview", "Overview", LayoutDashboard], ["gaps", "Gaps", ListChecks], ["budget", "Budget", Coins],
    ["simulate", "Simulate", FlaskConical], ["roadmap", "Roadmap", MapIcon], ["policy", "Policy scan", FileSearch], ["coach", "Coach", MessageCircle],
  ];

  /* ------------------------------ form phase ------------------------------ */
  if (phase === "form") return (
    <main className="max-w-xl mx-auto px-4 py-8">
      <h1 className="serif text-3xl mb-1" style={{ color: "var(--pine)" }}>Your personal risk, reasoned out.</h1>
      <p className="text-sm mb-6" style={{ color: "var(--mute)" }}>Five short steps. A rules engine sizes your covers; AI explains every rupee. All cover amounts in ₹ Lakhs.</p>
      <div className="flex gap-1.5 mb-6">
        {steps.map((s, i) => (
          <div key={s} className="flex-1">
            <div className="h-1.5 rounded-full transition-colors" style={{ background: i <= step ? "var(--leaf)" : "var(--line)" }} />
            <div className="text-xs mt-1.5 hidden sm:block" style={{ color: i === step ? "var(--pine)" : "var(--mute)", fontWeight: i === step ? 600 : 400 }}>{s}</div>
          </div>
        ))}
      </div>
      <div className="rounded-xl p-5 sm:p-6 border card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }} key={step}>
        {step === 0 && (<div>
          <Field label="Full name"><TextInput value={p.name} onChange={set("name")} placeholder="Rohan Mehta" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Email"><TextInput type="email" value={p.email} onChange={set("email")} placeholder="you@email.com" /></Field>
            <Field label="Phone"><TextInput type="tel" value={p.phone} onChange={set("phone")} placeholder="98765 43210" /></Field>
          </div>
          <p className="text-xs" style={{ color: "var(--mute)" }}>Used on your report and for the advisory record — never shared with insurers from this tool.</p>
          {/* [P8] DPDP Act 2023 — explicit consent before any storage; health disclosures are sensitive personal data */}
          <div className="mt-4 rounded-lg border p-3" style={{ borderColor: p.consent ? "var(--leaf)" : "var(--line)", background: p.consent ? "#F0F7F3" : "#FAFCFB" }}>
            <button role="checkbox" aria-checked={!!p.consent} onClick={() => setP((prev) => ({ ...prev, consent: !prev.consent, consentAt: !prev.consent ? Date.now() : null }))} className="flex items-start gap-2.5 text-left w-full"> {/* [§12][§14] consent is timestamped, withdrawal clears it */}
              <span className="w-5 h-5 rounded border flex items-center justify-center shrink-0 mt-0.5" style={{ borderColor: p.consent ? "var(--leaf)" : "var(--mute)", background: p.consent ? "var(--leaf)" : "#fff" }}>
                {p.consent && <Check size={13} color="#fff" />}
              </span>
              <span className="text-sm leading-snug">I consent to the storage and processing of my personal information — including health disclosures — for generating insurance recommendations and the broker's advisory record. I can withdraw consent at any time via "Delete my data" below.</span>
            </button>
            <button onClick={() => setShowPrivacy(!showPrivacy)} className="text-xs mt-2 underline" style={{ color: "var(--pine)" }}>
              {showPrivacy ? "Hide" : "Read"} privacy notice, disclaimers & your rights
            </button>
            {showPrivacy && (
              <div className="mt-2 text-xs leading-relaxed space-y-2" style={{ color: "#33443C" }}>
                <p><b>Purpose.</b> Your inputs size covers, generate reasoning, and create an advisory record for the advising broker. Nothing is sold to or shared with insurers from this tool.</p>
                <p><b>Where it lives.</b> On this device/app, and — only after you press Generate — in the broker's lead sheet if sync is configured.</p>
                <p><b>Your rights (DPDP Act 2023).</b> Access, correction, and erasure. <button onClick={eraseData} className="underline font-medium" style={{ color: "var(--red)" }}>Delete my data</button> removes records stored by this app; rows already synced to the broker's sheet are removed by the admin on request.{delMsg && <span className="block mt-1" style={{ color: "var(--pine)" }}>{delMsg}</span>}</p>
                <p><b>Disclaimers.</b> This is an insurance-advisory demonstration project. Insurance is the subject matter of solicitation. This tool offers educational guidance, not advice from a licensed professional; recommendations are indicative and subject to insurer underwriting. IRDAI does not endorse any rating or recommendation made here.</p>
              </div>
            )}
          </div>
        </div>)}
        {step === 1 && (<div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Age"><NumInput value={p.age} onChange={set("age")} placeholder="28" /></Field>
            <Field label="Marital status"><SelectInput value={p.marital} onChange={set("marital")} options={[["single", "Single"], ["married", "Married"]]} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="City"><SelectInput value={p.cityTier} onChange={set("cityTier")} options={[["metro", "Metro (Delhi, Mumbai…)"], ["nonmetro", "Tier-2 / smaller"]]} /></Field>
            <Field label="Occupation"><SelectInput value={p.occupation} onChange={set("occupation")} options={[["salaried", "Salaried"], ["self", "Self-employed"], ["business", "Business owner"]]} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Annual income" hint="₹ L"><NumInput value={p.incomeL} onChange={set("incomeL")} placeholder="8" /></Field>
            <Field label="Monthly expenses" hint="₹"><NumInput value={p.monthlyExp} onChange={set("monthlyExp")} placeholder="35000" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Outstanding loans" hint="₹ L"><NumInput value={p.loansL} onChange={set("loansL")} placeholder="40" /></Field>
            <Field label="Savings / investments" hint="₹ L"><NumInput value={p.savingsL} onChange={set("savingsL")} placeholder="3" /></Field>
          </div>
        </div>)}
        {step === 2 && (<div>
          {p.marital === "married" && <Field label="Spouse"><SelectInput value={p.spouseDep} onChange={set("spouseDep")} options={[["earning", "Earning"], ["homemaker", "Homemaker (dependent)"]]} /></Field>}
          <Field label="Children"><SelectInput value={p.kids} onChange={set("kids")} options={[["0", "None"], ["1", "1"], ["2", "2"], ["3", "3+"]]} /></Field>
          <Field label="Are your parents financially dependent on you?">
            <div className="flex gap-2">
              <ToggleChip on={p.parentsDep} onClick={() => set("parentsDep")(true)}>Yes</ToggleChip>
              <ToggleChip on={!p.parentsDep} onClick={() => set("parentsDep")(false)}>No</ToggleChip>
            </div>
          </Field>
          {p.parentsDep && <Field label="Eldest parent's age"><NumInput value={p.parentAge} onChange={set("parentAge")} placeholder="60" /></Field>}
        </div>)}
        {step === 3 && (<div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Vehicle owned"><SelectInput value={p.vehicle} onChange={set("vehicle")} options={[["none", "None"], ["bike", "Two-wheeler"], ["car", "Car"], ["both", "Car + bike"]]} /></Field>
            {p.vehicle !== "none" && <Field label="Motor policy"><SelectInput value={p.vehicleIns} onChange={set("vehicleIns")} options={[["none", "Not insured"], ["tp", "Third-party only"], ["comp", "Comprehensive"]]} /></Field>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {p.vehicle !== "none" && <Field label="Vehicle age" hint="years"><NumInput value={p.vehicleAge} onChange={set("vehicleAge")} placeholder="3" /></Field>}
            <Field label="Own a house?"><div className="flex gap-2 pt-1"><ToggleChip on={!!p.ownsHouse} onClick={() => set("ownsHouse")(true)}>Yes</ToggleChip><ToggleChip on={!p.ownsHouse} onClick={() => set("ownsHouse")(false)}>No</ToggleChip></div></Field>
          </div>
          <p className="text-xs font-semibold tracking-wider mt-2 mb-3" style={{ color: "var(--mute)" }}>EXISTING COVER (₹ L — leave 0 if none)</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Employer health"><NumInput value={p.covEmpHealthL} onChange={set("covEmpHealthL")} placeholder="3" /></Field>
            <Field label="Personal health"><NumInput value={p.covHealthL} onChange={set("covHealthL")} placeholder="5" /></Field>
            <Field label="Term life"><NumInput value={p.covTermL} onChange={set("covTermL")} placeholder="0" /></Field>
            <Field label="Critical illness"><NumInput value={p.covCIL} onChange={set("covCIL")} placeholder="0" /></Field>
            <Field label="Personal accident"><NumInput value={p.covPAL} onChange={set("covPAL")} placeholder="0" /></Field>
          </div>
          <p className="text-xs font-semibold tracking-wider mt-2 mb-3" style={{ color: "var(--mute)" }}>CLAIM READINESS</p>
          <div className="flex flex-wrap gap-2">
            <ToggleChip on={!!p.nominee} onClick={toggle("nominee")}>Nominees registered</ToggleChip>
            {p.marital === "married" && <ToggleChip on={!!p.nomineeUpdated} onClick={toggle("nomineeUpdated")}>Nominee updated after marriage</ToggleChip>} {/* [P9] */}
            <ToggleChip on={!!p.kyc} onClick={toggle("kyc")}>KYC complete</ToggleChip>
            <ToggleChip on={!!p.docsOk} onClick={toggle("docsOk")}>Policy docs accessible to family</ToggleChip>
            <ToggleChip on={!!p.renewalReminder} onClick={toggle("renewalReminder")}>Renewal reminders set</ToggleChip> {/* [P9] */}
            <ToggleChip on={!!p.emgContact} onClick={toggle("emgContact")}>Family knows whom to call</ToggleChip> {/* [P9] */}
            <ToggleChip on={!!p.claimFile} onClick={toggle("claimFile")}>Claim file prepared</ToggleChip> {/* [§8] */}
          </div>
        </div>)}
        {step === 4 && (<div>
          <Field label="Health factors" hint="select all that apply">
            <div className="divide-y" style={{ borderColor: "var(--line)" }}> {/* [§4] tri-state: unknowns lower confidence instead of silently meaning "no" */}
              <TriChip label="Smoker / tobacco" value={p.smoker} onChange={set("smoker")} />
              <TriChip label="Diabetes" value={p.diabetes} onChange={set("diabetes")} />
              <TriChip label="High blood pressure" value={p.bp} onChange={set("bp")} />
              <TriChip label="Family history — heart / cancer" value={p.famHistory} onChange={set("famHistory")} />
            </div>
            <p className="text-xs mt-1.5" style={{ color: "var(--mute)" }}>"Not sure" is a valid answer — the plan stays honest and simply shows lower confidence until you know.</p>
          </Field>
          <Field label="Financial goals" hint="optional">
            <div className="flex flex-wrap gap-2">
              {["Tax saving", "Child's education", "Retirement", "Buying a house"].map((g) => <ToggleChip key={g} on={p.goals.includes(g)} onClick={toggleGoal(g)}>{g}</ToggleChip>)}
            </div>
          </Field>
        </div>)}
        <div className="flex justify-between mt-5 pt-4 border-t" style={{ borderColor: "var(--line)" }}>
          <button onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}
            className={`flex items-center gap-1 text-sm px-3 py-2 rounded-lg ${step === 0 ? "opacity-0 pointer-events-none" : "chip-off border"}`}>
            <ChevronLeft size={15} /> Back
          </button>
          {step < 4 ? (
            <button onClick={() => canNext && setStep((s) => s + 1)} disabled={!canNext}
              className="flex items-center gap-1 text-sm px-4 py-2 rounded-lg text-white disabled:opacity-40" style={{ background: "var(--pine)" }}>
              Continue <ChevronRight size={15} />
            </button>
          ) : (
            <button onClick={() => generate(undefined, true)} className="flex items-center gap-1.5 text-sm px-5 py-2 rounded-lg text-white" style={{ background: "var(--pine)" }}>
              <Sparkles size={15} /> Build my plan
            </button>
          )}
        </div>
      </div>
      {!canNext && step === 0 && (
        <p className="text-xs mt-2 flex items-center gap-1" style={{ color: "var(--red)" }}><AlertTriangle size={12} /> Consent is required before any information is stored (DPDP Act 2023).</p>
      )}
      {!canNext && step === 1 && (
        <p className="text-xs mt-2 flex items-center gap-1" style={{ color: "var(--red)" }}><AlertTriangle size={12} /> Age (18+) and income are needed to size your covers.</p>
      )}
    </main>
  );

  /* ----------------------------- results phase ----------------------------- */
  return (
    <main className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between flex-wrap gap-2 mb-4">
        <div className="flex gap-1 overflow-x-auto pb-1">
          {TABS.map(([k, label, Icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg whitespace-nowrap border transition-colors ${tab === k ? "chip-on" : "chip-off"}`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setPhase("form"); setStep(0); }} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border chip-off"><Pencil size={14} /> Edit profile</button>
          <button onClick={download} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg text-white" style={{ background: "var(--pine)" }}><Download size={14} /> Report</button>
        </div>
      </div>

      {tab === "overview" && (<>
        <section className="rounded-xl border p-5 sm:p-6 flex flex-col sm:flex-row items-center gap-6 card-in" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
          <Gauge score={plan.score} band={plan.band} />
          <div className="flex-1">
            <div className="text-xs font-semibold tracking-widest mb-1" style={{ color: "var(--gold-deep)" }}>INDICATIVE PROTECTION SCORE · {p.name || "CLIENT"} {/* [P7] */}</div>
            <h2 className="serif text-2xl mb-2" style={{ color: "var(--pine)" }}>
              {plan.band === "At risk" ? "Big gaps, easy fixes." : plan.band === "Building cover" ? "A solid start — close the gaps." : "You're well covered."}
            </h2>
            <p className="text-sm leading-relaxed">{reasons?.overall}</p>
            <div className="mt-3 text-xs flex items-center gap-1.5" style={{ color: "var(--mute)" }}>
              {aiStatus === "loading" && <><Loader2 size={12} className="animate-spin" /> Claude is personalising your reasoning…</>}
              {aiStatus === "ai" && <><Sparkles size={12} /> Covers sized by rules engine · reasoning personalised by Claude</>}
              {aiStatus === "fallback" && <><Shield size={12} /> Covers sized by rules engine · built-in reasoning (AI offline)</>}
              <button onClick={() => setShowCalc(!showCalc)} className="ml-2 underline" style={{ color: "var(--pine)" }}>How it's calculated</button> {/* [P7] */}
            </div>
            {showCalc && <ScoreCalc c={plan} />}
          </div>
        </section>
        {lastDiff && <WhatChangedStrip d={lastDiff} />} {/* [§11] */}
        <AffordabilityStrip c={plan} onOptimize={(b) => { setBudgetSeed(b); setTab("budget"); }} /> {/* [P5] */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
          <MiniGauge value={plan.scores.healthRisk} label="Health Risk" invert />
          <MiniGauge value={plan.scores.finStability} label="Financial Stability" />
          <MiniGauge value={plan.scores.emergencyReady} label="Emergency Readiness" />
          <MiniGauge value={plan.scores.claimReady} label="Claim Readiness" />
        </div>
        {plan.claimGaps.length > 0 && ( /* [P9] every missing readiness item, named */
          <div className="flex flex-wrap items-center gap-1.5 mt-2 text-xs" style={{ color: "var(--mute)" }}>
            <span className="font-semibold">Claim readiness — missing:</span>
            {plan.claimGaps.map((g) => <span key={g} className="px-2 py-0.5 rounded-full" style={{ background: "#F8E3E1", color: "#A5322B" }}>{g}</span>)}
          </div>
        )}
        <div className="grid md:grid-cols-2 gap-4 mt-4">
          {recCards.map((card, i) => <RecCard key={card.key} {...card} reason={reasons?.[card.key]} delayMs={i * 70} />)}
        </div>
        <p className="text-xs mt-6 leading-relaxed" style={{ color: "var(--mute)" }}>
          Educational guidance from {BRAND}'s AI advisor — not a substitute for a licensed insurance professional. Cover amounts and premium ranges are indicative; final pricing and eligibility depend on insurer underwriting. No specific products or insurers are recommended. Insurance is the subject matter of solicitation; IRDAI does not endorse any recommendation made here. {/* [P8] */}
        </p>
      </>)}

      {tab === "gaps" && <GapTable p={p} c={plan} />}
      {tab === "budget" && <BudgetOptimizer p={p} c={plan} seed={budgetSeed} />}
      {tab === "simulate" && <LifeEventSim p={p} c={plan} onApply={(np) => { setP(np); generate(np); }} />}
      {tab === "roadmap" && <Roadmap p={p} c={plan} />}
      {tab === "policy" && <PolicyAnalyzer p={p} c={plan} />}
      {tab === "coach" && <Coach p={p} c={plan} />}
    </main>
  );
}

/* -------------------------------- Admin page --------------------------------- */
function AdminPage({ webhook, setWebhook }) {
  const { leads, loading, reload } = useLeads(true);
  const [hookInput, setHookInput] = useState(webhook || "");
  const [secretInput, setSecretInput] = useState("");
  useEffect(() => { stGet("settings:secret").then((v) => v && setSecretInput(v)); }, []); /* [§13] */
  const [msg, setMsg] = useState("");

  const stats = useMemo(() => {
    if (!leads.length) return null;
    const avg = Math.round(leads.reduce((s, l) => s + (l.score || 0), 0) / leads.length);
    const gapCount = {};
    leads.forEach((l) => { const g = l.topGap || "Unknown"; gapCount[g] = (gapCount[g] || 0) + 1; });
    const topGap = Object.entries(gapCount).sort((a, b) => b[1] - a[1])[0][0];
    const ageBuckets = { "18–25": 0, "26–30": 0, "31–35": 0, "36–40": 0, "41–50": 0, "50+": 0 };
    const incBuckets = { "<5L": 0, "5–10L": 0, "10–15L": 0, "15–25L": 0, "25L+": 0 };
    leads.forEach((l) => {
      const a = num(l.inputs?.age); const inc = num(l.inputs?.incomeL);
      ageBuckets[a <= 25 ? "18–25" : a <= 30 ? "26–30" : a <= 35 ? "31–35" : a <= 40 ? "36–40" : a <= 50 ? "41–50" : "50+"]++;
      incBuckets[inc < 5 ? "<5L" : inc < 10 ? "5–10L" : inc < 15 ? "10–15L" : inc < 25 ? "15–25L" : "25L+"]++;
    });
    return { avg, topGap, ageData: Object.entries(ageBuckets).map(([name, count]) => ({ name, count })), incData: Object.entries(incBuckets).map(([name, count]) => ({ name, count })) };
  }, [leads]);

  const downloadCsv = () => {
    const head = ["CustomerID", "Timestamp", "Name", "Email", "Phone", "Age", "City", "Occupation", "IncomeL", "LoansL", "ProtectionScore", "Band", "TopGap", "RecTerm", "RecHealth", "AISummary"];
    const lines = leads.map((l) => [l.id, new Date(l.ts).toISOString(), l.name, l.email, l.phone, l.inputs?.age, l.inputs?.cityTier, l.inputs?.occupation, l.inputs?.incomeL, l.inputs?.loansL, l.score, l.band, l.topGap, l.recs?.term, l.recs?.health, l.aiSummary].map(csvCell).join(","));
    const url = URL.createObjectURL(new Blob([head.join(",") + "\n" + lines.join("\n")], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = "advisor-leads.csv"; a.click(); URL.revokeObjectURL(url);
  };

  const saveHook = async () => { await stSet("settings:webhook", hookInput.trim()); await stSet("settings:secret", secretInput.trim()); setWebhook(hookInput.trim()); setMsg("Webhook + shared secret saved."); }; /* [§13] */
  const pullSheets = async () => {
    if (!webhook) { setMsg("Save a webhook URL first."); return; }
    setMsg("Fetching from Google Sheets…");
    try {
      const rows = await fetchSheetLeads(webhook);
      let added = 0;
      for (const r of rows || []) {
        if (!r.id) continue;
        const exists = await stGet("lead:" + r.id);
        if (!exists) { await saveLead({ id: r.id, ts: r.ts || Date.now(), name: r.name, email: r.email, phone: r.phone, inputs: { age: r.age, incomeL: r.incomeL, cityTier: r.city, occupation: r.occupation, loansL: r.loansL }, score: num(r.score), band: r.band, topGap: r.topGap, recs: {}, aiSummary: r.aiSummary }); added++; }
      }
      setMsg(`Synced — ${added} new lead(s) pulled from Sheets.`); reload();
    } catch (e) { setMsg("Couldn't reach the Sheet — this call is blocked inside the Claude preview, but works once the app is deployed."); }
  };

  const Stat = ({ label, value }) => (
    <div className="rounded-xl border p-4 flex-1 min-w-36" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      <div className="text-xs" style={{ color: "var(--mute)" }}>{label}</div>
      <div className="serif text-2xl mt-1" style={{ color: "var(--pine)" }}>{value}</div>
    </div>
  );
  const chartBox = { background: "var(--card)", borderColor: "var(--line)" };

  return (
    <main className="max-w-5xl mx-auto px-4 py-6">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Database size={16} style={{ color: "var(--pine)" }} />
        <h2 className="font-semibold">Admin dashboard</h2>
        <span className="text-xs px-2 py-0.5 rounded-full badge-low">Internal · demo</span>
        <div className="ml-auto flex gap-2">
          <button onClick={reload} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg border chip-off"><RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh</button>
          <button onClick={downloadCsv} disabled={!leads.length} className="flex items-center gap-1.5 text-sm px-3 py-2 rounded-lg text-white disabled:opacity-40" style={{ background: "var(--pine)" }}><Download size={14} /> CSV</button>
        </div>
      </div>

      {!leads.length && <p className="text-sm mb-4" style={{ color: "var(--mute)" }}>No leads yet — generate a plan on the Advisor page and it will appear here instantly.</p>}

      {stats && (<>
        <div className="flex gap-3 flex-wrap mb-4">
          <Stat label="Total customers" value={leads.length} />
          <Stat label="Avg protection score" value={stats.avg} />
          <Stat label="Most common gap" value={stats.topGap} />
        </div>
        <div className="grid md:grid-cols-2 gap-4 mb-4">
          <div className="rounded-xl border p-4" style={chartBox}>
            <div className="text-xs font-semibold tracking-wider mb-2" style={{ color: "var(--mute)" }}>AGE DISTRIBUTION</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.ageData}><CartesianGrid strokeDasharray="3 3" stroke="#E0E8E4" /><XAxis dataKey="name" fontSize={11} /><YAxis allowDecimals={false} fontSize={11} width={24} /><Tooltip /><Bar dataKey="count" fill="#0C3B2E" radius={[4, 4, 0, 0]} /></BarChart>
            </ResponsiveContainer>
          </div>
          <div className="rounded-xl border p-4" style={chartBox}>
            <div className="text-xs font-semibold tracking-wider mb-2" style={{ color: "var(--mute)" }}>INCOME DISTRIBUTION</div>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={stats.incData}><CartesianGrid strokeDasharray="3 3" stroke="#E0E8E4" /><XAxis dataKey="name" fontSize={11} /><YAxis allowDecimals={false} fontSize={11} width={24} /><Tooltip /><Bar dataKey="count" fill="#C89B3C" radius={[4, 4, 0, 0]} /></BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </>)}

      {leads.length > 0 && (
        <div className="rounded-xl border overflow-hidden mb-4" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
          <div className="px-4 py-2.5 border-b text-xs font-semibold tracking-wider" style={{ borderColor: "var(--line)", color: "var(--mute)" }}>LATEST LEADS</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 640 }}>
              <thead><tr className="text-xs" style={{ color: "var(--mute)" }}>{["ID", "When", "Name", "Phone", "Age", "Income", "Score", "Top gap"].map((h) => <th key={h} className="text-left font-medium px-4 py-2 border-b" style={{ borderColor: "var(--line)" }}>{h}</th>)}</tr></thead>
              <tbody>
                {leads.slice(0, 8).map((l) => (
                  <tr key={l.id} className="border-b last:border-0" style={{ borderColor: "var(--line)" }}>
                    <td className="px-4 py-2 text-xs mono">{l.id}</td>
                    <td className="px-4 py-2 text-xs">{new Date(l.ts).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                    <td className="px-4 py-2 font-medium">{l.name || "—"}</td>
                    <td className="px-4 py-2">{l.phone || "—"}</td>
                    <td className="px-4 py-2 tnum">{l.inputs?.age}</td>
                    <td className="px-4 py-2 tnum">₹{l.inputs?.incomeL} L</td>
                    <td className="px-4 py-2 tnum font-semibold" style={{ color: l.score >= 75 ? "var(--leaf)" : l.score >= 45 ? "var(--gold-deep)" : "var(--red)" }}>{l.score}</td>
                    <td className="px-4 py-2 text-xs">{l.topGap}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rounded-xl border p-4" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
        <div className="flex items-center gap-1.5 text-xs font-semibold tracking-wider mb-2" style={{ color: "var(--mute)" }}><Settings size={13} /> GOOGLE SHEETS SYNC</div>
        <p className="text-xs mb-3 leading-relaxed" style={{ color: "var(--mute)" }}>
          Paste your Apps Script Web App URL. New leads POST automatically on plan generation; "Pull from Sheets" imports rows back for analytics. Inside the claude.ai preview these external calls are sandbox-blocked — leads still save locally here, and the sync activates the moment you deploy the app on Vercel/Netlify or run it locally.
        </p>
        <div className="flex gap-2 flex-wrap">
          <input className={inputCls + " flex-1 min-w-64"} placeholder="https://script.google.com/macros/s/…/exec" value={hookInput} onChange={(e) => setHookInput(e.target.value)} />
          <input className={inputCls + " w-44"} placeholder="Shared secret" value={secretInput} onChange={(e) => setSecretInput(e.target.value)} /> {/* [§13] must match SECRET in the Apps Script */}
          <button onClick={saveHook} className="text-sm px-4 py-2 rounded-lg text-white" style={{ background: "var(--pine)" }}>Save</button>
          <button onClick={pullSheets} className="text-sm px-4 py-2 rounded-lg border chip-off">Pull from Sheets</button>
        </div>
        {msg && <p className="text-xs mt-2" style={{ color: "var(--gold-deep)" }}>{msg}</p>}
      </div>
    </main>
  );
}

/* ------------------------- report builder (kept + extended) ------------------ */
function buildReport(p, c, r) {
  const row = (name, rec, nowv, gap, priority, reason) => `
    <div style="border:1px solid #dfe7e3;border-radius:10px;padding:16px 18px;margin:12px 0;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <strong style="font-size:15px;color:#0C3B2E;">${name}</strong>
        <span style="font-size:11px;letter-spacing:.08em;color:${priority === "High" ? "#A2681B" : "#5C6F66"};">${priority.toUpperCase()} PRIORITY</span>
      </div>
      <div style="font-family:Georgia,serif;font-size:24px;color:#15221C;margin:6px 0;">${rec}</div>
      <div style="font-size:12.5px;color:#5C6F66;">Current: ${nowv} &nbsp;·&nbsp; Gap: <b style="color:${gap === "—" || gap === "₹0" ? "#2E7D5B" : "#C4443C"}">${gap}</b></div>
      <p style="font-size:13px;line-height:1.55;color:#33443C;margin:8px 0 0;">${reason}</p>
    </div>`;
  const s = c.scores;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Risk Advisory Report</title></head>
  <body style="font-family:'Segoe UI',Arial,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#15221C;">
    <div style="border-bottom:3px solid #0C3B2E;padding-bottom:14px;display:flex;justify-content:space-between;align-items:flex-end;">
      <div><div style="font-family:Georgia,serif;font-size:26px;color:#0C3B2E;">${BRAND}</div>
      <div style="font-size:12px;letter-spacing:.12em;color:#5C6F66;">AI PERSONAL RISK ADVISORY · ${(p.name || "").toUpperCase()}</div></div>
      <div style="text-align:right;font-size:12px;color:#5C6F66;">${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" })}</div>
    </div>
    <div style="display:flex;gap:24px;margin:16px 0;font-size:13px;color:#33443C;flex-wrap:wrap;">
      <span>Age <b>${c.age}</b></span><span>Income <b>${fmt(c.income)}/yr</b></span>
      <span>Loans <b>${fmt(c.loans)}</b></span><span>City <b>${c.metro ? "Metro" : "Non-metro"}</b></span>
      <span>Contact <b>${p.phone || "—"}</b></span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:8px;">
      ${[["Protection (indicative)", s.protection], ["Health Risk", s.healthRisk], ["Fin. Stability", s.finStability], ["Emergency", s.emergencyReady], ["Claim Ready", s.claimReady]].map(([k, v]) => `<div style="flex:1;min-width:110px;border:1px solid #dfe7e3;border-radius:10px;padding:10px 12px;text-align:center;"><div style="font-size:11px;color:#5C6F66;">${k}</div><div style="font-family:Georgia,serif;font-size:22px;color:#0C3B2E;">${v}</div></div>`).join("")}
    </div>
    <div style="background:#F0F5F2;border-radius:10px;padding:14px 18px;margin-bottom:6px;">
      <b style="color:#0C3B2E;">Verdict — ${c.band}</b>
      <p style="font-size:13px;margin:6px 0 0;color:#33443C;">${r.overall}</p>
      ${c.claimGaps.length ? `<p style="font-size:12px;margin:6px 0 0;color:#A5322B;"><b>Claim-readiness gaps:</b> ${c.claimGaps.join("; ")}.</p>` : ""}
      <p style="font-size:12px;margin:6px 0 0;color:#33443C;"><b>Protection affordability:</b> full plan ≈ ${fmt(c.afford.lo)}–${fmt(c.afford.hi)}/yr = ~${c.afford.pct}% of income (norm ~5–6%) — ${c.afford.status === "green" ? "comfortable" : c.afford.status === "yellow" ? "a stretch; sequence by priority" : "over budget; use the priority sequence"}.</p>
    </div>
    ${row("Health Insurance", (c.health.structure === "topup" ? `${fmt(c.health.base)} base + ${fmt(c.health.topUp)} super top-up (deductible ${fmt(c.health.deductible)}, saves ≈ ${fmt(c.health.save)}/yr vs flat)` : fmt(c.health.cover) + (c.health.floater ? " family floater" : " individual")) + (c.health.canPort ? " · PORT + enhance existing policy" : "") + (c.health.parentsMode === "senior-plan" ? ` + ${fmt(c.health.parentsPlan)} parents' plan` : "") + (c.health.parentsMode === "senior-caution" ? ` + parents (${c.parentAge}): attempt ${fmt(c.health.parentsPlan)} subject to underwriting + ${fmt(c.health.parentsCorpus)} medical corpus` : ""), fmt(c.health.now) + " (effective)", c.health.gap ? fmt(c.health.gap) : "₹0", "High", r.health)}
    ${row("Term Life Insurance", (!c.term.issuable && !c.term.now ? "Not typically issuable at this age" : fmt(c.term.cover)) + (c.term.capped ? " (capped at issuance limit)" : "") + (c.term.spouseCover ? ` + ${fmt(c.term.spouseCover)} homemaker spouse (replacement value)` : ""), c.term.now ? fmt(c.term.now) : "None", c.term.needed && c.term.gap ? fmt(c.term.gap) : "—", c.term.priority, r.term)}
    ${row("Personal Accident", fmt(c.accident.cover), c.accident.now ? fmt(c.accident.now) : "None", c.accident.gap ? fmt(c.accident.gap) : "₹0", c.accident.priority, r.accident)}
    ${row("Critical Illness", fmt(c.critical.cover), c.critical.now ? fmt(c.critical.now) : "None", c.critical.gap ? fmt(c.critical.gap) : "₹0", c.critical.priority, r.critical)}
    ${row("Motor Insurance", c.motor.hasVehicle ? "Comprehensive" + (c.motor.zeroDep ? " + zero-dep" : "") : "Not applicable", c.motor.status === "covered" ? "Comprehensive" : c.motor.status === "upgrade" ? "Third-party only" : c.motor.hasVehicle ? "Uninsured" : "—", "—", c.motor.status === "covered" || !c.motor.hasVehicle ? "Low" : "High", r.motor)}
    ${row("Emergency Fund", fmt(c.emergency.target) + ` (${c.emergency.months} months)`, fmt(c.emergency.now), c.emergency.gap ? fmt(c.emergency.gap) : "₹0", c.emergency.gap ? "High" : "Low", r.emergency)}
    <p style="font-size:10.5px;color:#8a978f;margin-top:18px;line-height:1.6;border-top:1px solid #dfe7e3;padding-top:10px;">
      <b>Audit:</b> Recommendation ${c.recId || "—"} · Engine v${ENGINE_VERSION} · Rules ${RULES_VERSION} · Generated ${new Date().toLocaleString("en-IN")} by ${BRAND} ·
      Profile ${c.completeness.pct}% complete · Confidence ${c.scoreConfidence} · Consent ${p.consent ? CONSENT_VERSION + " @ " + (p.consentAt ? new Date(p.consentAt).toLocaleString("en-IN") : "recorded") : "not recorded"}.
    </p>
    <p style="font-size:11px;color:#8a978f;margin-top:8px;line-height:1.5;">Educational guidance generated by ${BRAND}'s AI advisor. Not a substitute for a licensed insurance professional. Covers and premium ranges are indicative; final terms depend on insurer underwriting. Insurance is the subject matter of solicitation; IRDAI does not endorse any recommendation here. Personal data processed with the client's explicit consent (DPDP Act 2023)${p.consent ? " — consent recorded" : ""}; erasure available on request. Open in a browser and press Ctrl+P to save as PDF.</p>
  </body></html>`;
}

/* ================================ §9 APP ROOT ================================= */
export default function App() {
  const [page, setPage] = useState("advisor"); // advisor | admin
  const [phase, setPhase] = useState("form");
  const [p, setP] = useState({
    name: "Rohan Mehta", email: "rohan@example.com", phone: "9876543210",
    age: "28", marital: "single", cityTier: "metro", occupation: "salaried",
    incomeL: "8", monthlyExp: "35000", loansL: "40", savingsL: "3",
    spouseDep: "earning", kids: "0", parentsDep: true, parentAge: "60",
    vehicle: "bike", vehicleIns: "tp", vehicleAge: "3", ownsHouse: false,
    covEmpHealthL: "3", covHealthL: "5", covTermL: "0", covCIL: "0", covPAL: "0",
    nominee: false, nomineeUpdated: false, kyc: true, docsOk: false,
    renewalReminder: false, emgContact: false, claimFile: false, /* [P9][§8] */
    consent: false, consentAt: null, /* [P8][§14] must be explicitly given — never pre-ticked; timestamped when given */
    smoker: false, diabetes: false, bp: false, famHistory: true,
    goals: ["Tax saving"],
  });
  const [plan, setPlan] = useState(null);
  const [reasons, setReasons] = useState(null);
  const [aiStatus, setAiStatus] = useState("idle");
  const [webhook, setWebhook] = useState("");
  useEffect(() => { stGet("settings:webhook").then((v) => v && setWebhook(v)); }, []);

  return (
    <div className="min-h-screen app-root">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Public+Sans:wght@400;500;600;700&display=swap');
        .app-root{--pine:#0C3B2E;--pine-deep:#082A21;--leaf:#2E9E6B;--gold:#C89B3C;--gold-deep:#A2681B;
          --paper:#F4F7F5;--card:#FFFFFF;--ink:#15221C;--mute:#5C6F66;--line:#E0E8E4;--red:#C4443C;
          background:var(--paper);color:var(--ink);font-family:'Public Sans',system-ui,sans-serif;}
        .serif{font-family:'Fraunces',Georgia,serif;}
        .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;}
        .gauge-num{font-family:'Fraunces',Georgia,serif;font-size:30px;font-weight:700;}
        .tnum{font-variant-numeric:tabular-nums;}
        .input-brand{border:1px solid var(--line);color:var(--ink);}
        .input-brand:focus{border-color:var(--leaf);box-shadow:0 0 0 3px rgba(46,158,107,.15);}
        .chip-on{background:var(--pine);color:#fff;border-color:var(--pine);}
        .chip-off{background:#fff;color:var(--ink);border-color:var(--line);}
        .chip-off:hover{border-color:var(--leaf);}
        .badge-high{background:#F7EBD4;color:var(--gold-deep);}
        .badge-med{background:#E4F0EA;color:var(--pine);}
        .badge-low{background:#EEF1EF;color:var(--mute);}
        .badge-ok{background:#DFF2E8;color:#1F7A4F;}
        .badge-risk{background:#F8E3E1;color:#A5322B;}
        .needle{transition:all 1s cubic-bezier(.3,1.4,.5,1);}
        .card-in{animation:rise .5s ease both;}
        @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
        button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--leaf);outline-offset:2px;}
        @media (prefers-reduced-motion:reduce){.needle,.card-in{transition:none;animation:none}}
      `}</style>

      <header className="border-b" style={{ borderColor: "var(--line)", background: "var(--card)" }}>
        <div className="max-w-5xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: "var(--pine)" }}>
            <Shield size={18} color="#F7EBD4" />
          </div>
          <div>
            <div className="serif text-lg leading-tight" style={{ color: "var(--pine)" }}>{BRAND}</div>
            <div className="text-xs tracking-widest" style={{ color: "var(--mute)" }}>AI PERSONAL RISK ADVISOR</div>
          </div>
          <div className="ml-auto flex gap-1">
            <button onClick={() => setPage("advisor")} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border ${page === "advisor" ? "chip-on" : "chip-off"}`}><Shield size={14} /> Advisor</button>
            <button onClick={() => setPage("admin")} className={`flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border ${page === "admin" ? "chip-on" : "chip-off"}`}><Database size={14} /> Admin</button>
          </div>
        </div>
      </header>

      <ErrorBoundary>
        {page === "advisor"
          ? <AdvisorPage p={p} setP={setP} plan={plan} setPlan={setPlan} reasons={reasons} setReasons={setReasons} aiStatus={aiStatus} setAiStatus={setAiStatus} phase={phase} setPhase={setPhase} webhook={webhook} />
          : <AdminPage webhook={webhook} setWebhook={setWebhook} />}
      </ErrorBoundary>
    </div>
  );
}
